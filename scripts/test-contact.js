/**
 * scripts/test-contact.js — 联系我们页（帮助与支持）单测
 *
 * 把门口径 = Web ContactClient.tsx + lib/form-schema.ts contactSchema：
 *   - 字段校验文案逐项一致（邮箱空/格式、主题空/超50、留言 <10 / >1000）
 *   - 触摸时机：输入中不打扰、blur 后才显错、修正立即消错
 *   - 提交：无效 → 补显全部错误 + toast「请修正表单中的错误」零请求；
 *     有效 → POST /api/contact {email,subject,message} → 成功 toast 后返回；
 *     后端失败 → 透出 message
 *   - 已登录预填邮箱（authStore.userInfo.email）
 *
 * 运行：node scripts/test-contact.js
 */

const storage = new Map();
const requests = [];
const toasts = [];
let backCount = 0;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast(o) { toasts.push(o.title); },
  navigateBack(o) { backCount += 1; if (o && o.fail) o.fail = o.fail; },
  request(opt) {
    requests.push({ url: opt.url, method: opt.method, data: opt.data });
    setTimeout(() => opt.success({ statusCode: 200, data: { success: true, message: '邮件发送成功' } }), 2);
  },
};

let rawPage = null;
global.Page = (cfg) => { rawPage = cfg; };
require('../pages/contact/index');
const authStore = require('../store/authStore');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.error('  ✗ ' + label); }
}
function buildPage() {
  // 深拷贝：路径式 setData 会改写嵌套对象（errors/touched），
  // 浅拷贝会让前一个实例的状态泄漏到后续实例
  const store = JSON.parse(JSON.stringify(rawPage.data));
  return Object.assign(Object.create(rawPage), {
    data: store,
    setData(p) {
      // 支持小程序路径式 key（'errors.email'），与真机 setData 语义对齐
      Object.keys(p).forEach((k) => {
        const parts = k.split('.');
        if (parts.length === 2 && store[parts[0]] && typeof store[parts[0]] === 'object') {
          store[parts[0]][parts[1]] = p[k];
        } else {
          store[k] = p[k];
        }
      });
    },
  });
}
const settle = () => new Promise((r) => setTimeout(r, 10));

(async () => {
  console.log('== 预填邮箱（登录态） ==');
  authStore.setLoginData('tk', { userid: 'u1', email: 'a@b.com' });
  let page = buildPage();
  page.onLoad();
  ok(page.data.email === 'a@b.com', '登录用户邮箱预填');
  ok(page.data.isFormValid === false, '预填邮箱但主题/留言为空 → 表单无效');

  console.log('== 校验口径（contactSchema 文案一致） ==');
  page.onBlur({ currentTarget: { dataset: { name: 'email' } }, detail: { value: '' } });
  ok(page.data.errors.email === '邮箱不能为空', '邮箱空：邮箱不能为空');
  page.onBlur({ currentTarget: { dataset: { name: 'email' } }, detail: { value: 'abc' } });
  ok(page.data.errors.email === '请输入有效的邮箱地址', '邮箱格式：请输入有效的邮箱地址');
  page.onBlur({ currentTarget: { dataset: { name: 'subject' } }, detail: { value: '' } });
  ok(page.data.errors.subject === '主题不能为空', '主题空：主题不能为空');
  page.onBlur({ currentTarget: { dataset: { name: 'subject' } }, detail: { value: 'x'.repeat(51) } });
  ok(page.data.errors.subject === '主题不能超过50个字符', '主题 >50：主题不能超过50个字符');
  page.onBlur({ currentTarget: { dataset: { name: 'message' } }, detail: { value: '短' } });
  ok(page.data.errors.message === '留言内容至少需要10个字符', '留言 <10 字文案');

  console.log('== 触摸时机（输入不打扰 / 修正消错） ==');
  page = buildPage();
  page.onLoad();
  page.onInput({ currentTarget: { dataset: { name: 'email' } }, detail: { value: 'bad' } });
  ok(page.data.errors.email === '', '未触摸时输入不显错');
  page.onBlur({ currentTarget: { dataset: { name: 'email' } }, detail: { value: 'bad' } });
  ok(page.data.errors.email !== '', 'blur 后显错');
  page.onInput({ currentTarget: { dataset: { name: 'email' } }, detail: { value: 'ok@example.com' } });
  ok(page.data.errors.email === '', '修正立即消错');
  page.onInput({ currentTarget: { dataset: { name: 'message' } }, detail: { value: '这是一段超过十个字的留言内容' } });
  ok(page.data.messageLen === 14, '留言计数器实时联动');

  console.log('== 提交闭环 ==');
  const reqBefore = requests.length;
  toasts.length = 0;
  await page.onSubmit(); // 表单仍缺主题 → 拦截
  ok(requests.length === reqBefore, '无效表单零请求');
  ok(toasts[0] === '请修正表单中的错误', '无效表单 toast 口径');
  ok(page.data.errors.subject === '主题不能为空', '提交时补显未触摸字段错误');

  page.onInput({ currentTarget: { dataset: { name: 'subject' } }, detail: { value: '功能建议' } });
  ok(page.data.isFormValid === true, '三字段齐备 → 表单有效（按钮解禁）');
  await page.onSubmit();
  await settle();
  const last = requests[requests.length - 1];
  ok(last && last.url.endsWith('/api/contact') && last.method === 'POST' &&
    last.data.email === 'ok@example.com' && last.data.subject === '功能建议',
    'POST /api/contact 请求体正确');
  ok(toasts[toasts.length - 1] === '留言已发送！我们会尽快回复您。', '成功 toast 文案');
  await new Promise((r) => setTimeout(r, 1300));
  ok(backCount === 1, '成功后 navigateBack');
  ok(page.data.isLoading === false, 'loading 复位');

  console.log('');
  console.log('联系我们页：' + passed + ' 通过，' + failed + ' 失败');
  if (failed > 0) process.exit(1);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
