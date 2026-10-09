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
 *   - 经全局 getCurrentPages()（getPageStack 封装）自底向上找**最深处**的目标路由实例
 *     （栈里若已有多条重复，回退到最深处即弹出其上全部重复层，顺带去重）；
 *   - 已存在 → wx.navigateBack({ delta }) 回退到该实例；实例若实现
 *     singletonReload(query) 钩子则就地换参刷新（播放列表切集后回退到
 *     栈内旧精听/剧集页时重指到新集，内容不陈旧；同参由页面自行 no-op）；
 *   - 不存在 → 正常 wx.navigateTo 压栈。
 *
 * 页面实例的 route 字段无前导斜杠（如 'pages/episode/episode'），
 * 入参 url 带不带开头斜杠均可。
 *
 * 2026-10-09 根因修复（精听页经面板「精听模式」二次进入被重新加载）：
 * 原实现调用 wx.getCurrentPages()——微信运行时**不存在**该 API
 * （页面栈查询是逻辑层全局函数 getCurrentPages()，与 App/Page/getApp
 * 同级，不挂在 wx 上）。真机/开发者工具里 wx.getCurrentPages 为
 * undefined → 调用抛 TypeError → 被 try/catch 吞掉按「空栈」处理 →
 * 永远走 navigateTo 压栈：精听页上点「精听模式」压入第二个精听页实例
 * （onLoad 全量重拉、句子高亮/扫光复位），封面 → 剧集页同样重复压栈。
 * 单测此前把 getCurrentPages mock 在 wx 上，恰好掩盖了该问题。
 * 现统一经 getPageStack() 读取：优先全局 getCurrentPages，wx 挂载仅作兜底。
 */

/**
 * 读取当前页面栈（数组首项为最底层页面，末项为栈顶/当前显示页）。
 * 优先使用逻辑层全局 getCurrentPages()（微信官方唯一口径）；
 * 个别测试桩/历史环境若仅挂在 wx 上则兜底读取；均不可用时返回空栈。
 */
function getPageStack() {
  try {
    if (typeof getCurrentPages === 'function') {
      return getCurrentPages() || []; // eslint-disable-line no-undef
    }
    if (typeof wx !== 'undefined' && wx && typeof wx.getCurrentPages === 'function') {
      return wx.getCurrentPages() || [];
    }
  } catch (e) {
    // 页面栈不可用（极早期/异常环境）→ 按空栈处理
  }
  return [];
}

/** 栈顶页面实例（当前正在显示的页面）；空栈返回 null */
function getTopPage() {
  const pages = getPageStack();
  return pages.length ? pages[pages.length - 1] : null;
}

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
    const routes = getPageStack().map((p) => p.route);
    console.info('[单例路由] ' + action + (delta ? '(delta=' + delta + ')' : '') +
      ' → ' + path + ' ｜ 当前栈深 ' + routes.length + '：[' + routes.join(' › ') + ']');
  } catch (e) {
    // 日志失败不影响导航
  }
}

function singletonNavigateTo(url) {
  const { path, query } = parseUrl(url);
  // 页面栈不可用时 getPageStack 返回 [] → 按不存在处理直接压栈
  const pages = getPageStack();

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

module.exports = { singletonNavigateTo, parseUrl, getPageStack, getTopPage };
