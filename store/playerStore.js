const Store = require('./core.js');

class PlayerStore extends Store {
  constructor() {
    super({
      isPlaying: false,
      currentEpisode: null,
      currentTime: 0,
      duration: 0,
      playlist: []
    });
  }

  setEpisode(episode) {
    this.setState({ currentEpisode: episode, isPlaying: true });
  }

  setPlayingState(isPlaying) {
    this.setState({ isPlaying });
  }

  updateProgress(currentTime, duration) {
    this.setState({ currentTime, duration });
  }
}

module.exports = new PlayerStore();
