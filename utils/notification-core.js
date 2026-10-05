/**
 * utils/notification-core.js — 消息通知纯函数层（Node 可测）
 *
 * 复刻 Web 端 app/(main)/notifications/NotificationsClient.tsx 的常量与派生：
 *   - TABS 六段过滤（全部/评论/回复/点赞/系统/更新；客户端过滤，Web 同款——
 *     后端 /api/notification/list 无分页参数，全量倒序返回）
 *   - TYPE_LABEL / TYPE_BADGE 七类型映射（评论/点赞/成就/系统/回复/更新/学习；
 *     STUDY 有标签有徽章但不在 TABS，Web 同款）
 *   - formatDistanceZh：date-fns zh-CN formatDistanceToNow(addSuffix) 全语义移植
 *     （阈值与文案逐条对齐 date-fns/formatDistance + zh-CN/_lib/formatDistance：
 *     秒差 trunc 取整后分钟四舍五入；45/90 分钟与 1440/2520/43200/86400 分钟
 *     阈值；月差按日历月计算，含「二月 27 日后锚点改 30 + 月末特例」口径）
 *   - mapItem：DTO → 展示模型（timeText/typeLabel/badge/target 预派生，
 *     WXML 零方法调用红线）
 *   - resolveTarget：Web targetUrl → 小程序路由映射（/episode/{id} → 剧集页，
 *     /charts → 学习报表页；管理端自定义 URL 不映射，仅标已读）
 *
 * 时间解析沿用收听历史页 parseUtcToLocal 口径：后端送 UTC ISO 串，真机 JSC
 * 对带毫秒/Z 的 ISO 解析存在兼容差异，手工拼 UTC 分量后交 Date.UTC 取本地时区。
 */

/** 过滤 Tab（顺序与文案钉死，对齐 NotificationsClient TABS） */
const TABS = [
  { id: 'ALL', label: '全部' },
  { id: 'COMMENT', label: '评论' },
  { id: 'REPLY', label: '回复' },
  { id: 'LIKE', label: '点赞' },
  { id: 'SYSTEM', label: '系统' },
  { id: 'EPISODE_UPDATE', label: '更新' },
];

/** 类型中文标签（对齐 TYPE_LABEL；含 TABS 外的 ACHIEVEMENT/STUDY） */
const TYPE_LABEL = {
  COMMENT: '评论',
  LIKE: '点赞',
  ACHIEVEMENT: '成就',
  SYSTEM: '系统',
  REPLY: '回复',
  EPISODE_UPDATE: '更新',
  STUDY: '学习',
};

/**
 * 类型 → 徽章色键（对齐 Web TYPE_BADGE 的 daisy 语义色，映射到本项目令牌）：
 *   info=黛蓝 / like=曙光橙 / success=绿浅档 / neutral=墨灰 /
 *   primary=品牌绿 / update=黛蓝深档 / study=橙深档
 */
const TYPE_BADGE = {
  COMMENT: 'info',
  LIKE: 'like',
  ACHIEVEMENT: 'success',
  SYSTEM: 'neutral',
  REPLY: 'primary',
  EPISODE_UPDATE: 'update',
  STUDY: 'study',
};

/** date-fns 常量（分钟粒度）：一天 / 近两天阈值 / 一月(30d) */
const MINUTES_IN_DAY = 1440;
const MINUTES_IN_ALMOST_TWO_DAYS = 2520;
const MINUTES_IN_MONTH = 43200;

/** UTC ISO → 本地时区 Date；解析失败返回 null（真机 JSC 兼容口径） */
function parseIso(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return isNaN(d.getTime()) ? null : d;
}

/** 是否当月最后一天（对齐 date-fns isLastDayOfMonth） */
function isLastDayOfMonth(d) {
  const test = new Date(d.getTime());
  test.setDate(test.getDate() + 1);
  return test.getDate() === 1;
}

/**
 * 日历月差（对齐 date-fns differenceInMonths(now, past)，now ≥ past 方向）：
 * 先取年月差 cal，再回退 cal 个月得锚点——锚点早于 past 说明最后一个月未满，
 * 差值减一；二月 27 日后锚点改 30 日防溢出回卷，now 恰为月末且 cal=1 时视作满月
 * （Jan31→Feb28 = 1 个月的 date-fns 口径）。
 */
function diffInMonths(now, past) {
  const cal =
    (now.getFullYear() - past.getFullYear()) * 12 +
    (now.getMonth() - past.getMonth());
  if (cal === 0) return 0;
  const working = new Date(now.getTime());
  if (working.getMonth() === 1 && working.getDate() > 27) working.setDate(30);
  working.setMonth(working.getMonth() - cal);
  let notFull = working.getTime() < past.getTime();
  if (isLastDayOfMonth(now) && cal === 1 && now.getTime() > past.getTime()) {
    notFull = false;
  }
  return cal - (notFull ? 1 : 0);
}

/**
 * 相对时间文案（date-fns zh-CN formatDistanceToNow {addSuffix} 全语义）：
 * "不到 1 分钟前" / "N 分钟前" / "大约 N 小时前" / "N 天前" /
 * "大约 N 个月前" / "N 个月前" / "大约|超过|将近 N 年前"。
 * 未来时间（服务器时钟超前）返回空串——Web 端同场景渲染 date-fns 未来的
 * "…内"文案，通知业务不出现，此处显式收敛。
 */
function formatDistanceZh(iso, now) {
  const date = parseIso(iso);
  if (!date) return '';
  const base = now instanceof Date ? now : new Date(now || Date.now());
  const seconds = Math.trunc((base.getTime() - date.getTime()) / 1000);
  if (seconds < 0) return '';
  const minutes = Math.round(seconds / 60); // 同时区无 DST 偏移项
  if (minutes < 2) {
    return minutes === 0 ? '不到 1 分钟前' : minutes + ' 分钟前';
  }
  if (minutes < 45) return minutes + ' 分钟前';
  if (minutes < 90) return '大约 1 小时前';
  if (minutes < MINUTES_IN_DAY) {
    return '大约 ' + Math.round(minutes / 60) + ' 小时前';
  }
  if (minutes < MINUTES_IN_ALMOST_TWO_DAYS) return '1 天前';
  if (minutes < MINUTES_IN_MONTH) {
    return Math.round(minutes / MINUTES_IN_DAY) + ' 天前';
  }
  if (minutes < MINUTES_IN_MONTH * 2) {
    return '大约 ' + Math.round(minutes / MINUTES_IN_MONTH) + ' 个月前';
  }
  const months = diffInMonths(base, date);
  if (months < 12) {
    return Math.round(minutes / MINUTES_IN_MONTH) + ' 个月前';
  }
  const rem = months % 12;
  const years = Math.trunc(months / 12);
  if (rem < 3) return '大约 ' + years + ' 年前';
  if (rem < 9) return '超过 ' + years + ' 年前';
  return '将近 ' + (years + 1) + ' 年前';
}

/**
 * Web targetUrl → 小程序路由(后端 core/episode 产出 /episode/{id},achievements
 * 产出 /library/learning-report——历史上曾误发 /charts 且 Web 端无该路由,
 * 存量通知仍需映射;管理端 send 可填任意 URL——不映射仅标已读)
 */
function resolveTarget(url) {
  if (typeof url !== 'string' || !url) return '';
  const ep = url.match(/\/episode\/([A-Za-z0-9_-]+)/);
  if (ep) return '/pages/episode/episode?id=' + ep[1];
  const path = url.split('?')[0];
  // 新口径 /library/learning-report + 存量 /charts 均落学习报表页
  if (path === '/library/learning-report' || path === '/charts') {
    return '/pages/profile/learning-report/index';
  }
  return '';
}

/** 单条 DTO → 展示模型 */
function mapItem(raw, now) {
  const r = raw || {};
  const type = r.type || 'SYSTEM';
  return {
    id: r.notificationid,
    text: r.notificationText || '',
    isRead: !!r.isRead,
    type,
    typeLabel: TYPE_LABEL[type] || type,
    badge: TYPE_BADGE[type] || 'neutral',
    timeText: formatDistanceZh(r.notificationAt, now),
    target: resolveTarget(r.targetUrl),
  };
}

/** 列表 DTO（{unreadCount, notifications}）→ 展示模型（unreadCount 缺失时本地派生） */
function mapList(dto, now) {
  const items = ((dto && dto.notifications) || []).map((n) => mapItem(n, now));
  const unreadCount =
    dto && typeof dto.unreadCount === 'number'
      ? dto.unreadCount
      : items.filter((n) => !n.isRead).length;
  return { items, unreadCount };
}

/** 客户端 Tab 过滤（对齐 displayedNotifications：ALL 全量，其余按 type 精确匹配） */
function filterByTab(list, tab) {
  if (!tab || tab === 'ALL') return list;
  return list.filter((n) => n.type === tab);
}

module.exports = {
  TABS,
  TYPE_LABEL,
  TYPE_BADGE,
  formatDistanceZh,
  parseIso,
  diffInMonths,
  resolveTarget,
  mapItem,
  mapList,
  filterByTab,
};
