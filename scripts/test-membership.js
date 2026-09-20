/**
 * scripts/test-membership.js — membershipStore 会员判定逻辑单测（Node 环境，mock wx）
 *
 * 覆盖场景（口径见 REVIEW-TASK.md T0.2 / §3.1）：
 *   1. 游客：isPremium=false，ensureFresh 不发请求
 *   2. 本地 USER + 订阅表有效 → 权威校正为 PREMIUM（纯移动端付费用户 role 滞后）
 *   3. 资料刷新（fetchProfile 回写）不回退权威校正、不重复打接口；TTL 内 ensureFresh 命中缓存
 *   4. force=true 强制重新校正（订阅到期）；随后资料刷新带回 PREMIUM 缓存也不回退 USER 结论
 *   5. 登出清空会员态；本地 PREMIUM（过期缝隙）被校正回 USER —— 口径红线
 *   6. ADMIN 直通，且权威结论不被资料刷新回退
 *   7. 校正失败保持乐观值、不记 TTL；下次 ensureFresh 自动重试
 *
 * mock 约定：profileRole 模拟 /api/user/profile 回写的 DB 展示缓存 role。
 * 注意过期会员的 DB role 仍为 PREMIUM（role 不会自动降级，订阅表才是事实），
 * 测试必须保持该前提自洽。
 *
 * 运行：node scripts/test-membership.js（或 npm test）
 */

// ---- mock 全局 wx（必须在 require store/request 之前） ----
let subscriptionCalls = 0;
let nextResponse = { statusCode: 200, data: { role: 'USER' } };
let profileRole = 'USER';

global.wx = {
  _storage: {},
  getStorageSync(k) {
    return this._storage[k] !== undefined ? this._storage[k] : '';
  },
  setStorageSync(k, v) {
    this._storage[k] = v;
  },
  removeStorageSync(k) {
    delete this._storage[k];
  },
  getAccountInfoSync() {
    return { miniProgram: { envVersion: 'develop' } };
  },
  showToast() {},
  request(opts) {
    if (opts.url.includes('/api/user/subscription/status')) {
      subscriptionCalls++;
      opts.success({ statusCode: nextResponse.statusCode, data: nextResponse.data });
      return;
    }
    if (opts.url.includes('/api/user/profile')) {
      opts.success({ statusCode: 200, data: { User: { role: profileRole } } });
      return;
    }
    opts.success({ statusCode: 200, data: {} });
  },
};

const authStore = require('../store/authStore');
const membership = require('../store/membershipStore');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  // —— 场景 1：游客 ——
  membership.init();
  assert(membership.getState().isPremium === false, 'S1 游客 isPremium=false');
  assert(membership.getState().role === '', 'S1 游客 role 为空');
  await membership.ensureFresh();
  assert(subscriptionCalls === 0, 'S1 游客 ensureFresh 不发请求');

  // —— 场景 2：本地 USER，订阅表有效 → 校正为 PREMIUM ——
  profileRole = 'USER';
  nextResponse = { statusCode: 200, data: { role: 'PREMIUM' } };
  authStore.setLoginData('token-A', { userid: 'u1', role: 'USER' });
  assert(
    membership.getState().isPremium === false,
    'S2 登录瞬间按本地 role 乐观判定（USER → false）',
  );
  await settle();
  const s2 = membership.getState();
  assert(
    s2.role === 'PREMIUM' && s2.isPremium === true && s2.checked === true,
    'S2 订阅表校正 USER → PREMIUM（role 滞后的付费用户被解锁）',
  );

  // —— 场景 3：资料刷新不回退权威结论、不重打接口；TTL 命中 ——
  const callsAfterS2 = subscriptionCalls;
  authStore.setState({ userInfo: { userid: 'u1', role: 'USER' } }); // 模拟 fetchProfile 回写
  await settle();
  assert(
    membership.getState().isPremium === true && membership.getState().role === 'PREMIUM',
    'S3 资料刷新不回退权威校正（PREMIUM）',
  );
  assert(subscriptionCalls === callsAfterS2, 'S3 资料刷新不重复请求 subscription/status');
  await membership.ensureFresh();
  assert(subscriptionCalls === callsAfterS2, 'S3 TTL 内 ensureFresh 命中缓存不打接口');

  // —— 场景 4：force 强制刷新（订阅到期）；PREMIUM 缓存回写也不回退 ——
  nextResponse = { statusCode: 200, data: { role: 'USER' } };
  await membership.ensureFresh(true);
  assert(
    membership.getState().isPremium === false && membership.getState().role === 'USER',
    'S4 force 后按订阅表校正回 USER（订阅到期）',
  );
  profileRole = 'PREMIUM'; // 过期会员的 DB role 仍滞留 PREMIUM（展示缓存不自动降级）
  authStore.setState({ userInfo: { userid: 'u1', role: 'PREMIUM' } });
  await settle();
  assert(
    membership.getState().isPremium === false,
    'S4 权威 USER 结论不被资料刷新带回的 PREMIUM 缓存回退（口径红线的守卫方向）',
  );
  profileRole = 'USER';

  // —— 场景 5：登出清空；本地 PREMIUM（过期缝隙）被校正回 USER ——
  authStore.logout();
  await settle();
  const s5a = membership.getState();
  assert(
    s5a.isPremium === false && s5a.role === '' && s5a.checked === false,
    'S5 登出清空会员态',
  );
  profileRole = 'PREMIUM'; // DB role 滞留 PREMIUM，与过期缝隙前提自洽
  authStore.setLoginData('token-B', { userid: 'u1', role: 'PREMIUM' });
  assert(
    membership.getState().isPremium === true,
    'S5 登录瞬间本地 PREMIUM 乐观解锁（缝隙期）',
  );
  await settle();
  assert(
    membership.getState().isPremium === false,
    'S5 过期 PREMIUM 缓存被订阅表校正回 USER（口径红线）',
  );

  // —— 场景 6：ADMIN 直通，且权威结论不被资料刷新回退 ——
  authStore.logout();
  await settle();
  profileRole = 'ADMIN';
  nextResponse = { statusCode: 200, data: { role: 'ADMIN' } };
  authStore.setLoginData('token-C', { userid: 'admin', role: 'ADMIN' });
  await settle();
  assert(
    membership.getState().isPremium === true && membership.getState().role === 'ADMIN',
    'S6 ADMIN 直通且权威结论不被资料刷新回退',
  );

  // —— 场景 7：校正失败保持乐观值、不记 TTL；下次 ensureFresh 重试 ——
  authStore.logout();
  await settle();
  profileRole = 'PREMIUM'; // 前提仍是「本地缓存 PREMIUM 的用户」
  nextResponse = { statusCode: 500, data: { message: 'server error' } };
  authStore.setLoginData('token-D', { userid: 'u2', role: 'PREMIUM' });
  await settle();
  const s7a = membership.getState();
  assert(
    s7a.isPremium === true && s7a.checked === false,
    'S7 校正失败保持本地乐观值（checked=false）',
  );
  nextResponse = { statusCode: 200, data: { role: 'USER' } };
  await membership.ensureFresh(); // 失败未记 TTL → 应重新请求
  assert(
    membership.getState().isPremium === false && membership.getState().checked === true,
    'S7 失败后下次 ensureFresh 自动重试并成功校正',
  );

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL MEMBERSHIP TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
