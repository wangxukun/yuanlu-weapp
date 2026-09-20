/**
 * store/membershipStore — 会员判定服务（复习模块所有 PRO 门禁的事实来源）
 *
 * 口径红线（与 Web 端 core/auth/guard.ts isPremiumUser 一致）：
 *   role === 'ADMIN' 直通；否则以订阅表事实为准——
 *   /api/user/subscription/status 回传的 role 由后端按订阅表实时派生
 *   （deriveDisplayRole：ADMIN 直通 / 有效订阅 → PREMIUM / 其余 → USER），
 *   本地 userInfo.role 只是展示缓存，可能滞后（纯移动端付费用户 role 仍是
 *   USER、已过期会员 role 仍是 PREMIUM），必须以权威校正为准。
 *
 * 用法：
 *   const membership = require('../store/membershipStore');
 *   const { isPremium } = membership.getState();   // 乐观快照（同步）
 *   membership.ensureFresh().then(...)             // 权威校正（异步，TTL + 并发去重）
 *   membership.ensureFresh(true).then(...)         // 强制刷新（购买/支付回调后）
 *
 * 服务端 403 PREMIUM_REQUIRED 门禁是最终兜底：本服务仅保证 UI 呈现口径，
 * 校正失败时保持乐观值，越权请求仍会被服务端拦下（对齐 ai-deep-dive 模式）。
 */
const Store = require('./core.js');
const authStore = require('./authStore');
const { get } = require('../utils/request');

// 权威校正结果的信任时长：期内 ensureFresh 直接命中缓存，force 可强制刷新
const FRESH_TTL_MS = 5 * 60 * 1000;

class MembershipStore extends Store {
  constructor() {
    super({
      isPremium: false, // 是否享有 PRO 权益（ADMIN 或有效订阅）
      role: '',         // 派生角色：USER / PREMIUM / ADMIN（'' = 未登录）
      checked: false,   // 是否已完成一次 subscription/status 权威校正
    });
    this._pending = null;       // 在途校正请求（并发去重）
    this._checkedAt = 0;        // 上次校正成功的时间戳（TTL 用）
    this._correctedToken = '';  // 校正结论所属的 token（换号/登出后失效）
    this._unsubAuth = null;
  }

  /** app.js onLaunch 调用：本地乐观判定 + 订阅 authStore 变化联动 */
  init() {
    if (!this._unsubAuth) {
      this._unsubAuth = authStore.subscribe(() => this.deriveLocal());
    }
    this.deriveLocal();
  }

  /**
   * 本地 role 乐观判锁（同步、零请求）。authStore 任何变化都会触发：
   * - 登出：清空会员态
   * - 登录/换号：按本地 role 乐观判定，并后台静默发起权威校正
   * - 资料刷新（fetchProfile 回写）：已有权威校正且 token 未变时跳过——
   *   subscription 派生 role 的权威级高于 DB 展示缓存 role，不能被回退
   */
  deriveLocal() {
    const { isLoggedIn, userInfo, token } = authStore.getState();
    if (!isLoggedIn) {
      this._pending = null;
      this._checkedAt = 0;
      this._correctedToken = '';
      this.setState({ isPremium: false, role: '', checked: false });
      return;
    }
    if (this.state.checked && this._correctedToken === token) return;

    const role = (userInfo && userInfo.role) || 'USER';
    this._checkedAt = 0; // 身份变化后下次 ensureFresh 重新权威校正
    this.setState({ isPremium: role === 'PREMIUM' || role === 'ADMIN', role });
    // 后台静默校正（对齐 ai-deep-dive syncAuthState → refreshMembership）
    this.ensureFresh();
  }

  /**
   * 权威校正：GET /api/user/subscription/status。
   * - TTL 内且非 force：直接返回当前态，不打接口
   * - 并发调用共享同一在途请求
   * - 在途期间登出/换号：丢弃过期结论
   * - 校正失败：静默保持乐观值，且不记 TTL（下次 ensureFresh 自动重试）
   * @returns {Promise<{isPremium: boolean, role: string, checked: boolean}>}
   */
  ensureFresh(force = false) {
    if (!authStore.getState().isLoggedIn) {
      return Promise.resolve(this.getState());
    }
    if (
      !force &&
      this._checkedAt > 0 &&
      Date.now() - this._checkedAt < FRESH_TTL_MS
    ) {
      return Promise.resolve(this.getState());
    }
    if (this._pending) {
      return this._pending;
    }

    const reqToken = authStore.getState().token;
    this._pending = get('/api/user/subscription/status')
      .then((res) => {
        const auth = authStore.getState();
        if (!auth.isLoggedIn || auth.token !== reqToken) {
          return this.getState();
        }
        if (res && res.role) {
          this.setState({
            isPremium: res.role === 'PREMIUM' || res.role === 'ADMIN',
            role: res.role,
            checked: true,
          });
          this._checkedAt = Date.now();
          this._correctedToken = reqToken;
        }
        return this.getState();
      })
      .catch(() => this.getState())
      .then((state) => {
        this._pending = null;
        return state;
      });
    return this._pending;
  }
}

module.exports = new MembershipStore();
