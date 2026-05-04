# WZBC-Douyin-news-scraper

温州商学院抖音主页视频爬虫，用于自动采集指定时间段内发布的作品信息。

## 功能

- 使用 Playwright 驱动 Chrome 浏览器打开抖音主页
- 自动滚动并监听作品接口（`/aweme/v1/web/aweme/post/`）
- 按年月过滤非置顶视频，保存标题、来源链接等字段
- 遇到超出目标月份的非置顶视频自动停止，避免无效请求

## 环境要求

- Node.js（建议 18+）
- Chrome 浏览器
- Playwright（`node_modules/playwright`）

## 使用方法

```bash
# 默认爬取 2026 年 4 月的视频，最多滚动 120 次
node douyin_scraper.js

# 自定义最大滚动次数
node douyin_scraper.js --max-scrolls 200
```

运行后会自动打开 Chrome 窗口并跳转到目标主页。如遇到验证码或登录页面，请手动完成验证，然后回到命令行按 Enter 继续。

采集结果会保存为 `douyin_videos_<年>_<月>_<时间戳>.json`。

## 配置说明

修改 `douyin_scraper.js` 顶部的常量即可调整目标：

```js
const PROFILE_URL = "https://www.douyin.com/user/...";  // 目标主页 URL
const TARGET_YEAR = 2026;                                // 目标年份
const TARGET_MONTH = 4;                                  // 目标月份
```

## 输出格式

```json
[
  {
    "title": "视频标题",
    "via": "来源标记",
    "aweme_id": "7634471798696444084",
    "url": "https://www.douyin.com/video/7634471798696444084"
  }
]
```
