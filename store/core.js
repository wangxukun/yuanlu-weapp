/**
 * 轻量级全局状态管理基类 (发布-订阅模式)
 */
class Store {
  constructor(initialState = {}) {
    this.state = initialState;
    this.listeners = [];
  }

  // 获取当前状态
  getState() {
    return this.state;
  }

  // 更新状态并通知所有订阅者
  setState(partialState) {
    this.state = { ...this.state, ...partialState };
    this.notify();
  }

  // 订阅状态变化
  subscribe(listener) {
    this.listeners.push(listener);
    // 返回取消订阅函数
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  // 通知更新
  notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

module.exports = Store;
