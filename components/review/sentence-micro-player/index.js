/**
 * components/review/sentence-micro-player — 句子微播放器（裸图标形态）
 * 复刻 Web components/sentence/SentenceMicroPlayer.tsx 的移动端形态
 * （`flex items-center gap-1` + 仅播放/循环两个裸图标；胶囊容器与进度
 * 切片条是 sm+ 断点样式，移动端不渲染——2026-09-26 三轮走查对齐截图）：
 *
 * - 按 startTime→endTime 精准截取播放剧集原音（audio-clip 显式窗口模式，
 *   免文本定位）；同 key 再点 = 停止（toggle）；开播自动停 TTS/BGM（audio-bus）
 * - 播放/暂停：裸圆钮（loading 转圈 / 空闲灰 Play / 播放中 primary Pause）
 * - 单句循环：裸圆钮（关 = Repeat 灰 / 开 = Repeat1 主题色）；
 *   audio-clip.setLoop 播放中切换不打断、到窗终回 seek 句首续播
 *   （600ms 静默窗防真机陈旧 currentTime 误触发，见 audio-clip 注释）
 */
const audioClip = require('../../../utils/audio-clip');
const theme = require('../../../utils/theme');

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 收藏句 id（播放 key 派生：同句在卡片/清单两视图共享播放态） */
    sentenceId: { type: null, value: null },
    episodeid: { type: String, value: '' },
    startTime: { type: Number, value: 0 },
    endTime: { type: Number, value: 0 },
  },

  data: {
    playing: false,
    loading: false,
    loop: false,
    dark: false,
    playSrc: '/assets/icons/play-filled-gray.svg',
    loopSrc: '/assets/icons/repeat.svg',
  },

  lifetimes: {
    attached() {
      const dark = theme.getEffective() === 'dark';
      this.setData({
        dark,
        playSrc: dark
          ? '/assets/icons/play-filled-graydark.svg'
          : '/assets/icons/play-filled-gray.svg',
        loopSrc: dark
          ? '/assets/icons/repeat-graydark.svg'
          : '/assets/icons/repeat.svg',
      });
      this._key = this.data.episodeid + ':s' + this.data.sentenceId;
      this._unsubState = audioClip.subscribe((s) => this._onState(s));
      this._onState(audioClip.getState());
    },
    detached() {
      if (this._unsubState) this._unsubState();
    },
  },

  methods: {
    _onState(s) {
      const key = this._key;
      const playing = !!(s && s.playingKey === key);
      const loading = !!(s && s.loadingKey === key);
      // 同值守卫：列表内每个卡片各挂一个实例且全订阅同一广播，
      // 无条件 setData 会让 N 个实例在每次播放态变化时各发一次通信
      if (playing !== this.data.playing || loading !== this.data.loading) {
        this.setData({ playing, loading });
      }
    },

    onTogglePlay() {
      if (this.data.loading) return;
      audioClip.play({
        key: this._key,
        episodeid: this.data.episodeid,
        startTime: this.data.startTime,
        endTime: this.data.endTime,
      });
    },

    onToggleLoop() {
      const loop = !this.data.loop;
      this.setData({ loop });
      audioClip.setLoop(loop);
    },
  },
});
