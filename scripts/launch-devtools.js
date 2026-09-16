/** scripts/launch-devtools.js — 用官方 automator.launch 拉起开发者工具自动化 */
const automator = require("miniprogram-automator");

automator
  .launch({
    cliPath: "D:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat",
    projectPath: "D:\\WebstormProjects\\yuanlu-weapp",
    port: 9420,
    timeout: 150000,
  })
  .then((mp) => {
    console.log("LAUNCH_SUCCESS");
    return mp.disconnect();
  })
  .catch((e) => {
    console.log("LAUNCH_FAILED:", e.message);
    process.exit(1);
  });
