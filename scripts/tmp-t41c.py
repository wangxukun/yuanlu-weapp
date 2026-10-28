# -*- coding: utf-8 -*-
import io, sys
p = "pages/intensive-listening/index.wxml"
with io.open(p, "r", encoding="utf-8", newline="") as f: s = f.read()

def rep(old, new):
    global s
    assert old in s, "WXML NOT FOUND: " + old[:80]
    s = s.replace(old, new, 1)

# 1) 三 Tab（扫光/捕词/精析）
rep("""      <!-- 精读 / 听写 双 Tab（📖 / ✍️ 前缀原样保留，选中白底 + 阴影） -->
      <view class="il-tabs">
        <view class="il-tab {{mode === 'read' ? 'il-tab--on' : ''}}" data-mode="read" bindtap="onSwitchMode">📖 精读</view>
        <view class="il-tab {{mode === 'dictate' ? 'il-tab--on' : ''}}" data-mode="dictate" bindtap="onSwitchMode">✍️ 听写</view>
      </view>""",
"""      <!-- 三 Tab（T4.1）：跟听扫光 / 捕词听写 / 语境精析 -->
      <view class="il-tabs">
        <view class="il-tab {{mode === 'read' ? 'il-tab--on' : ''}}" data-mode="read" bindtap="onSwitchMode">📖 扫光</view>
        <view class="il-tab {{mode === 'dictate' ? 'il-tab--on' : ''}}" data-mode="dictate" bindtap="onSwitchMode">✍️ 捕词</view>
        <view class="il-tab {{mode === 'insight' ? 'il-tab--on' : ''}}" data-mode="insight" bindtap="onSwitchMode">🔍 精析</view>
      </view>""")

# 2) 工具行：显微镜第四钮（仅扫光模式）+ 倍速胶囊（微剧场）
rep("""      <view class="il-tools row">
        <view wx:if="{{mode === 'read'}}" class="il-tool {{wordSweep ? 'il-tool--on' : ''}} tap-dim" bindtap="onToggleWordSweep">""",
"""      <view class="il-tools row">
        <view wx:if="{{isSceneMode}}" class="il-rate row">
          <view class="il-rate-chip {{rateLabel === '0.75x' ? 'il-rate-chip--on' : ''}}" data-rate="0.75" bindtap="onRatePick">0.75x</view>
          <view class="il-rate-chip {{rateLabel === '1x' ? 'il-rate-chip--on' : ''}}" data-rate="1" bindtap="onRatePick">1x</view>
          <view class="il-rate-chip {{rateLabel === '1.25x' ? 'il-rate-chip--on' : ''}}" data-rate="1.25" bindtap="onRatePick">1.25x</view>
        </view>
        <view wx:if="{{mode === 'read'}}" class="il-tool {{linkRead ? 'il-tool--on' : ''}} tap-dim" bindtap="onToggleLinkRead">
          <text class="il-tool-flash">⚡</text>
          <text>连读</text>
        </view>
        <view wx:if="{{mode === 'read'}}" class="il-tool {{wordSweep ? 'il-tool--on' : ''}} tap-dim" bindtap="onToggleWordSweep">""")

# 3) 微剧场画报头卡（滚动区首卡，仅 scene 模式）
rep("""      <!-- ── 游客试听墙：字幕流尾部解锁按钮""",
"""      <!-- ── 微剧场画报头卡（T4.1，仅 scene 模式）：封面 + 标题 + 语用标签 + 时长 + 播控 ── -->
      <view wx:if="{{isSceneMode && scene}}" class="il-hero">
        <image class="il-hero-cover" src="{{scene.coverUrl}}" mode="aspectFill" />
        <view class="il-hero-shade"></view>
        <view class="il-hero-body col">
          <view class="row il-hero-tags" wx:if="{{scene.situationTag || scene.cefrLevel}}">
            <text class="il-hero-pill" wx:if="{{scene.situationTag}}">{{scene.situationTag}}</text>
            <text class="il-hero-pill" wx:if="{{scene.cefrLevel}}">{{scene.cefrLevel}}</text>
          </view>
          <text class="il-hero-title ellipsis-2">{{scene.title}}</text>
          <view class="row between w-full il-hero-foot">
            <text class="il-hero-dur">微剧场 · 约 {{scene.duration}}s</text>
            <view class="il-hero-play center tap-scale" bindtap="onHeroToggle">
              <view wx:if="{{isPlaying}}" class="il-hero-bars row">
                <view class="il-hero-bar"></view><view class="il-hero-bar"></view><view class="il-hero-bar"></view>
              </view>
              <image wx:else class="il-hero-play-ic" src="/assets/icons/play-filled-ink.svg" />
            </view>
          </view>
        </view>
      </view>

      <!-- ── 游客试听墙：字幕流尾部解锁按钮""")

# 4) 游客解锁按钮仅剧集模式
rep('      <view wx:if="{{!isLoggedIn}}" class="il-unlock">',
    '      <view wx:if="{{!isLoggedIn && !isSceneMode}}" class="il-unlock">')

# 5) 字幕卡：词闪电标 + 琥珀高亮 + 选区高亮；字幕块仅非精析模式渲染
rep("""            <block wx:if="{{item.words.length > 0}}">""",
"""            <block wx:if="{{item.words.length > 0}}">""" )  # 占位（下方统一替换词行）

# 6) 词行：flash/sel class + ⚡ 块首标
old_word = """              <text wx:for="{{item.words}}" wx:for-item="w" wx:for-index="wi" wx:key="wi"
                    class="{{fmt.wordCls(item.active, wi, item.swIdx, item.swOn)}} font-serif"
                    catchtap="onWordTap" data-index="{{item.index}}" data-wi="{{wi}}">{{w.word}} </text>"""
new_word = """              <block wx:for="{{item.words}}" wx:for-item="w" wx:for-index="wi" wx:key="wi">
                <text wx:if="{{linkRead && w.flHead}}" class="w-flash-mark">⚡</text><text
                    class="{{fmt.wordCls(item.active, wi, item.swIdx, item.swOn)}} font-serif {{linkRead && w.fl ? 'w--flash' : ''}} {{phrase && !phrase.pending && phrase.index === item.index && wi >= phrase.startWi && wi <= phrase.endWi ? 'w--sel' : ''}}"
                    catchtap="onWordTap" data-index="{{item.index}}" data-wi="{{wi}}">{{w.word}} </text>
              </block>"""
rep(old_word, new_word)

# 7) 词块点读坞（固定底卡）+ 精析面板 + 插入位置：premium-modal 之前
rep("""  <!-- ═══ 会员转化弹窗（配额墙） ═══ -->""",
"""  <!-- ═══ 词块点读慢放坞（T4.1 显微镜：原速/慢镜/三连放/收词） ═══ -->
  <view wx:if="{{phrase}}" class="il-dock-wrap">
    <view class="il-dock row">
      <view class="col flex-1 il-dock-info">
        <text class="il-dock-text ellipsis">{{phrase.text}}</text>
        <text class="t-mini text-secondary">{{phrase.pending ? phrase.durText : phrase.durText + ' · 词块窗口'}}</text>
      </view>
      <block wx:if="{{!phrase.pending}}">
        <view class="il-dock-btn center {{phrasePlaying ? 'il-dock-btn--on' : ''}}" data-mode="fast" bindtap="onPhrasePlay">原速</view>
        <view class="il-dock-btn center {{phrasePlaying ? 'il-dock-btn--on' : ''}}" data-mode="slow" bindtap="onPhrasePlay">慢镜</view>
        <view class="il-dock-btn il-dock-btn--main center" data-mode="triple" bindtap="onPhrasePlay">三连放</view>
        <view class="il-dock-btn center" bindtap="onPhraseSave">收词</view>
      </block>
      <view class="il-dock-close center" bindtap="onPhraseClose">
        <image class="il-dock-close-ic" src="/assets/icons/close.svg" />
      </view>
    </view>
  </view>

  <!-- ═══ 语境精析面板（T4.1 第三 Tab：scene 内联 deepDive / 剧集内嵌精析组件） ═══ -->
  <view wx:if="{{mode === 'insight'}}" class="il-insight">
    <block wx:if="{{isSceneMode}}">
      <view wx:if="{{insight}}">
        <view class="ii-sec" wx:if="{{insight.vocabulary.length > 0}}">
          <text class="ii-sec-title">重点词汇</text>
          <view class="ii-vocab row" wx:for="{{insight.vocabulary}}" wx:key="word">
            <view class="col flex-1">
              <view class="row">
                <text class="ii-vocab-word">{{item.word}}</text>
                <text class="ii-vocab-ph" wx:if="{{item.phonetic}}">{{item.phonetic}}</text>
              </view>
              <text class="ii-vocab-meaning">{{item.meaning}}{{item.reason ? ' · ' + item.reason : ''}}</text>
            </view>
          </view>
        </view>
        <view class="ii-sec" wx:if="{{insight.sentences.length > 0}}">
          <text class="ii-sec-title">长难句拆解</text>
          <view class="ii-sent col" wx:for="{{insight.sentences}}" wx:key="text">
            <text class="ii-sent-en">{{item.text}}</text>
            <text class="ii-sent-an">{{item.analysis}}</text>
          </view>
        </view>
        <view class="ii-sec" wx:if="{{insight.quiz.length > 0}}">
          <text class="ii-sec-title">随堂小测</text>
          <view class="ii-quiz col" wx:for="{{insight.quiz}}" wx:key="idx" wx:for-index="qi">
            <text class="ii-quiz-q">{{qi + 1}}. {{item.question}}</text>
            <view class="ii-quiz-opt {{quizPick[item.idx] === oi ? (oi === item.answerIndex ? 'ii-quiz-opt--ok' : 'ii-quiz-opt--bad') : ''}}"
                  wx:for="{{item.options}}" wx:for-item="opt" wx:for-index="oi" wx:key="oi"
                  data-q="{{item.idx}}" data-o="{{oi}}" bindtap="onQuizPick">{{opt}}</view>
            <text class="ii-quiz-ex" wx:if="{{quizPick[item.idx] !== undefined}}">{{item.explanation}}</text>
          </view>
        </view>
      </view>
      <view wx:else class="ii-empty col center">
        <text class="t-body text-secondary">这段微剧场暂无精析内容，先去扫光页精研吧</text>
      </view>
    </block>
    <block wx:else>
      <ai-deep-dive episode-id="{{episodeid}}" />
    </block>
  </view>

  <!-- ═══ 会员转化弹窗（配额墙） ═══ -->""")

with io.open(p, "w", encoding="utf-8", newline="") as f: f.write(s)
print("patch-C wxml ok")
