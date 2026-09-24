/**
 * utils/route.js — 单例路由（页面栈查重跳转）
 *
 * 背景（2026-09-23 栈溢出 bug）：全屏播放面板的「封面 → 剧集详情」与
 * 「精听模式 → 精听页」此前只做**栈顶**守卫——同路由页面埋在栈更深处时
 * 仍会 navigateTo 重复压栈；剧集页 ↔ 精听页经面板来回切换即形成乒乓
 * 循环（Ping-Pong），快速触顶 10 层页面栈上限，返回键只能逐层退出
 * 重复实例，回不到主流程。
 *
 * singletonNavigateTo(url)：
 *   - 经 wx.getCurrentPages() 自底向上找**最深处**的目标路由实例
 *     （栈里若已有多条重复，回退到最深处即弹出其上全部重复层，顺带去重）；
 *   - 已存在 → wx.navigateBack({ delta }) 回退到该实例；实例若实现
 *     singletonReload(query) 钩子则就地换参刷新（播放列表切集后回退到
 *     栈内旧精听/剧集页时重指到新集，内容不陈旧；同参由页面自行 no-op）；
 *   - 不存在 → 正常 wx.navigateTo 压栈。
 *
 * 页面实例的 route 字段无前导斜杠（如 'pages/episode/episode'），
 * 入参 url 带不带开头斜杠均可。
 */

/** url → { path, query }；path 归一为无前导斜杠，query 值解码 */
function parseUrl(url) {
  const [rawPath, rawQuery] = String(url || '').split('?');
  const query = {};
  (rawQuery || '').split('&').filter(Boolean).forEach((kv) => {
    const idx = kv.indexOf('=');
    if (idx > 0) query[kv.slice(0, idx)] = decodeURIComponent(kv.slice(idx + 1));
  });
  return { path: (rawPath || '').replace(/^\//, ''), query };
}

/**
 * 单例跳转。返回实际动作 { action: 'push' | 'back' | 'noop', delta }
 * （供单测断言与调用方区分 no-op；业务方一般忽略返回值）。
 * 每次决策输出 console.info 日志（devtools Console 可实时观察栈深与路由，
 * 验证单例：面板/精听乒乓操作下栈深应恒定不涨）。
 */
function logDecision(action, path, delta) {
  try {
    const routes = (wx.getCurrentPages() || []).map((p) => p.route);
    console.info('[单例路由] ' + action + (delta ? '(delta=' + delta + ')' : '') +
      ' → ' + path + ' ｜ 当前栈深 ' + routes.length + '：[' + routes.join(' › ') + ']');
  } catch (e) {
    // 日志失败不影响导航
  }
}

function singletonNavigateTo(url) {
  const { path, query } = parseUrl(url);
  let pages = [];
  try {
    pages = wx.getCurrentPages() || [];
  } catch (e) {
    // 页面栈不可用（极早期/异常环境）→ 按不存在处理直接压栈
  }

  // 自底向上：第一个命中即最深处实例，回退到它 = 弹出其上所有层（含重复）
  let targetIdx = -1;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i] && pages[i].route === path) {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx < 0) {
    logDecision('压栈', path, 0);
    wx.navigateTo({ url });
    return { action: 'push', delta: 0 };
  }

  const target = pages[targetIdx];
  const delta = pages.length - 1 - targetIdx;
  if (delta > 0) {
    logDecision('回退', path, delta);
    wx.navigateBack({ delta });
  } else {
    logDecision('栈顶命中 no-op', path, 0);
  }
  // 回退到的实例就地换参刷新（无 delta 时 = 栈顶已是目标页，同样允许
  // 换参，典型场景：播放列表切集后在本页直接重指新集而不压新页）
  if (target && typeof target.singletonReload === 'function') {
    try {
      target.singletonReload(query);
    } catch (e) {
      // 钩子异常不阻断导航
    }
  }
  return { action: delta > 0 ? 'back' : 'noop', delta };
}

module.exports = { singletonNavigateTo, parseUrl };
