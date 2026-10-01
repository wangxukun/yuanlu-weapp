/**
 * utils/download-manager.js — 音频离线缓存下载编排（DOWNLOAD-TASK T3.1）
 *
 * 职责：会员音频「下载即离线缓存」的单一出口——
 *   GET /api/episode/download（requirePremium，经 request.js 自动带 Bearer）
 *   → 拿 OSS 公开签名直链（免鉴权头，1h 有效 + attachment 头小程序端无感）
 *   → wx.downloadFile（显式 10 分钟超时，整集 m4a 大文件防 60s 默认超时，附录 B 第 4 条）
 *   → FileSystemManager.saveFile 落 `${USER_DATA_PATH}/audio/{episodeid}.{ext}`
 *
 * 关键口径：
 *   - 并发去重：同 episodeid 在途共享同一 Promise
 *   - 失败自动重试 1 次（复用同一条签名直链重下；不重新签名——1h 有效期内重下足够）
 *   - 索引存 wx storage（download_index，仅元数据）：{ path, size, savedAt, lastPlayedAt, title }
 *     ——LRU 配额驱逐是 T3.2 的策略层，本模块只提供 usage/touch 原语
 *   - 自愈：索引命中但文件已被外部清除（用户清缓存等）→ access 失败即剔除索引条目
 *
 * 事件（subscribe 监听，T3.3 按钮三态/进度环的数据源）：
 *   { type: 'progress'|'retry'|'downloaded'|'error'|'removed'|'cleared', episodeid, ... }
 *
 * audioManager 本地优先播放接线（T3.4）：播放前先 getCachedPath(episodeid) 命中即用本地路径。
 */
const { get } = require('./request');

const INDEX_KEY = 'download_index';
/** 整集音频显式超时：10 分钟（wx.downloadFile 默认 60s 对大文件不够） */
const DOWNLOAD_TIMEOUT = 10 * 60 * 1000;
/** 网络失败/非 200 自动重试次数（任务口径：1 次自动重下） */
const MAX_AUTO_RETRY = 1;
/**
 * 本地文件配额驱逐线（T3.2）：全小程序本地文件上限 200MB，预留 buffer 取 180MB。
 * 超线按 LRU 驱逐（时钟 = lastPlayedAt，未播回退 savedAt），永远排除当次剧集；
 * 双点执行：下载前预检腾位 + 落盘后硬保证。可经 setUsageLimit 调整（测试/调优钩子）。
 */
let usageLimit = 180 * 1024 * 1024;

// 环境守卫（T3.4）：自动化测试桩可能缺 env/getFileSystemManager，模块加载不炸，
// fs 缺失时错误延后到实际读写处（各调用点均有 try/catch 兜底语义）
const AUDIO_DIR = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '') + '/audio';
const fs = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null;

/** 索引（读穿透：storage 每次直读，微信 storage 自带内存层开销可忽略；
 *  避免内存缓存与外部写入（测试注入/多页写）出现陈旧。
 *  注意：mutator 必须持 loadIndex() 返回的对象改完调 saveIndex(idx) 写回——
 *  键不存在时 loadIndex 每次返回新对象，无参写回会丢更新） */
function loadIndex() {
  const raw = wx.getStorageSync(INDEX_KEY);
  return raw && typeof raw === 'object' ? raw : {};
}

function saveIndex(idx) {
  wx.setStorageSync(INDEX_KEY, idx || loadIndex());
}

/** 在途下载：episodeid → Promise<localPath>（并发去重） */
const pending = {};
/** 事件订阅者 */
const listeners = [];

function emit(evt) {
  listeners.slice().forEach((cb) => {
    try {
      cb(evt);
    } catch (e) {
      // 订阅方异常不阻断广播
    }
  });
}

/** audio 目录幂等创建（EEXIST 容忍） */
function ensureDir() {
  try {
    fs.mkdirSync(AUDIO_DIR, true);
  } catch (e) {
    // 已存在或不可创建；后续 saveFile 失败会走统一错误路径
  }
}

/** 从签名直链解析扩展名（剥 query）；非法/缺失兜底 m4a（历史批次已迁 m4a） */
function extFromUrl(url) {
  const m = String(url || '').split('?')[0].match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : 'm4a';
}

/**
 * 下载（或命中缓存）。@param episode 剧集对象（至少 episodeid；title 供缓存管理展示）
 * @param opts.onProgress 进度回调（0-100，可选；另有 subscribe 全局事件）
 * @returns Promise<本地文件路径>
 */
function download(episode, opts) {
  const episodeid = episode && episode.episodeid;
  if (!episodeid) return Promise.reject(new Error('缺少 episodeid'));

  const cached = getCachedPath(episodeid);
  if (cached) return Promise.resolve(cached);

  if (pending[episodeid]) return pending[episodeid]; // 并发去重

  const onProgress = opts && opts.onProgress;
  pending[episodeid] = (async () => {
    // 0. 预检腾位：当前用量已超线先驱逐（不待下载完成；排除本集）
    evictLRU(episodeid);
    // 1. 后端拿签名直链（requirePremium；签名 URL 本身公开，downloadFile 免鉴权头）
    const body = await get(`/api/episode/download?episodeid=${episodeid}`);
    const downloadUrl = body && body.downloadUrl;
    if (!downloadUrl) throw new Error(body && body.error ? body.error : '获取下载链接失败');

    // 2. downloadFile → 落盘（自动重试 1 次）
    const dest = `${AUDIO_DIR}/${episodeid}.${extFromUrl(downloadUrl)}`;
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_AUTO_RETRY; attempt += 1) {
      if (attempt > 0) emit({ type: 'retry', episodeid, attempt });
      try {
        const tempPath = await downloadToTemp(downloadUrl, episodeid, onProgress);
        persist(episodeid, episode.title || '', tempPath, dest);
        // 3. 落盘后硬保证：新总量超线驱逐（刚落盘的本集永不驱逐）
        evictLRU(episodeid);
        emit({ type: 'downloaded', episodeid, path: dest });
        return dest;
      } catch (e) {
        lastErr = e;
      }
    }
    emit({ type: 'error', episodeid, error: lastErr && lastErr.message });
    throw lastErr;
  })().finally(() => {
    delete pending[episodeid];
  });

  return pending[episodeid];
}

/** 单次 downloadFile 到临时路径；statusCode 非 200 视为失败 */
function downloadToTemp(url, episodeid, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wx.downloadFile({
      url,
      timeout: DOWNLOAD_TIMEOUT,
      success: (res) => {
        if (res.statusCode === 200) {
          resolve(res.tempFilePath);
        } else {
          reject(new Error(`下载失败（HTTP ${res.statusCode}）`));
        }
      },
      fail: (err) => reject(new Error((err && err.errMsg) || '下载失败')),
    });
    if (task && task.onProgressUpdate && onProgress) {
      task.onProgressUpdate((res) => {
        onProgress(res.progress);
        emit({ type: 'progress', episodeid, progress: res.progress });
      });
    }
  });
}

/** 临时文件 → 目标路径落盘 + 索引登记（size 供 getUsage/LRU） */
function persist(episodeid, title, tempPath, dest) {
  ensureDir();
  try {
    fs.saveFileSync(tempPath, dest);
  } catch (e) {
    throw new Error('保存离线文件失败');
  }
  let size = 0;
  try {
    size = fs.statSync(dest).size || 0;
  } catch (e) {
    // stat 失败不阻断，size 记 0
  }
  const idx = loadIndex();
  idx[episodeid] = {
    path: dest,
    size,
    savedAt: Date.now(),
    lastPlayedAt: 0,
    title,
  };
  saveIndex(idx);
}

/**
 * 缓存命中查询：索引命中且文件实际存在才返回路径；
 * 索引脏（文件被外部清除）自愈剔除并广播 removed。
 */
function getCachedPath(episodeid) {
  const entry = loadIndex()[episodeid];
  if (!entry) return null;
  try {
    fs.accessSync(entry.path);
    return entry.path;
  } catch (e) {
    const idx = loadIndex();
    delete idx[episodeid];
    saveIndex(idx);
    emit({ type: 'removed', episodeid, reason: 'stale' });
    return null;
  }
}

/** T3.4 播放命中时调用：刷新 LRU 时钟（T3.2 驱逐依据） */
function touch(episodeid) {
  const entry = loadIndex()[episodeid];
  if (entry) {
    entry.lastPlayedAt = Date.now();
    saveIndex(loadIndex());
  }
}

/** 索引条目查询（size/title 等元数据；存在性校验走 getCachedPath。T4.1 分享 10MB 限速用） */
function getEntry(episodeid) {
  return loadIndex()[episodeid] || null;
}

/** 删除单集缓存（文件 + 索引） */
function remove(episodeid) {
  const idx = loadIndex();
  const entry = idx[episodeid];
  if (!entry) return;
  try {
    fs.unlinkSync(entry.path);
  } catch (e) {
    // 文件已不在（自愈同口径）
  }
  delete idx[episodeid];
  saveIndex(idx);
  emit({ type: 'removed', episodeid });
}

/** 清空全部离线缓存 */
function clearAll() {
  const idx = loadIndex();
  Object.keys(idx).forEach((id) => {
    try {
      fs.unlinkSync(idx[id].path);
    } catch (e) {
      // 尽力删除
    }
    delete idx[id];
  });
  saveIndex(idx);
  emit({ type: 'cleared' });
}

/** 用量汇总（索引 size 求和；LRU 阈值判断数据源） */
function getUsage() {
  const idx = loadIndex();
  let bytes = 0;
  let count = 0;
  Object.keys(idx).forEach((id) => {
    count += 1;
    bytes += idx[id].size || 0;
  });
  return { bytes, count };
}

/** 事件订阅 @returns 退订函数 */
function subscribe(cb) {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i !== -1) listeners.splice(i, 1);
  };
}

/**
 * LRU 时钟：已播看 lastPlayedAt，未播回退 savedAt
 * （刚下载未播的条目不会被误判为"最旧"；但当次剧集本身由 keepId 排除兜底）
 */
function lruClock(entry) {
  return entry.lastPlayedAt > 0 ? entry.lastPlayedAt : entry.savedAt;
}

/**
 * 驱逐到驱逐线内（T3.2）。@param keepId 永不驱逐的剧集（当次下载）
 * 双点调用：download 预检腾位 + persist 后硬保证。尽力而为不抛错；
 * 单文件超线的极端场景驱逐全部其余条目后停（keepId 保住）。
 * 阈值判定按全部条目总量计（含 keepId——否则当次文件自身导致的超量会漏判），
 * 驱逐只从候选（排除 keepId）中按 LRU 挑。
 * @returns 被驱逐的 episodeid 列表（按驱逐顺序）
 */
function evictLRU(keepId) {
  const idx = loadIndex();
  const allIds = Object.keys(idx);
  let total = 0;
  allIds.forEach((id) => {
    total += idx[id].size || 0;
  });
  if (total <= usageLimit) return [];

  const candidates = allIds
    .filter((id) => id !== keepId)
    .sort((a, b) => lruClock(idx[a]) - lruClock(idx[b]));
  const evicted = [];
  for (let i = 0; i < candidates.length && total > usageLimit; i += 1) {
    const id = candidates[i];
    const entry = idx[id];
    total -= entry.size || 0;
    try {
      fs.unlinkSync(entry.path);
    } catch (e) {
      // 文件已不在（与自愈同口径，索引照删）
    }
    delete idx[id];
    evicted.push(id);
    emit({ type: 'removed', episodeid: id, reason: 'lru' });
  }
  if (evicted.length) saveIndex(idx);
  return evicted;
}

/** 驱逐线调整（测试注入/未来调优钩子；字节） */
function setUsageLimit(bytes) {
  usageLimit = bytes;
}

module.exports = {
  download,
  getCachedPath,
  getEntry,
  remove,
  clearAll,
  getUsage,
  touch,
  subscribe,
  evictLRU,
  setUsageLimit,
  AUDIO_DIR,
};
