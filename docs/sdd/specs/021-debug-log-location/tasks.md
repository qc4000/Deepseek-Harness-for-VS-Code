# 任务清单 021：日志位置（globalStorage + 迁移）

## 阶段 1

- [x] `[impl]` `debugLogDirFrom/debugLogPathFor/debugLogFileName` + `debugLogPath` 切换为 globalStorage 优先
- [x] `[impl]` `migrateLegacyDebugLog`（只复制一次、不覆盖）+ `ensureDebugLog` 接线
- [x] `[test]` `[22]`：目录三分支、路径拼接、迁移内容一致、二次不重复

## 阶段 2

- [x] `[test]` `TMPDIR=/tmp npm run test:one -- dsh-sidebar` → `TMPDIR=/tmp npm test` 全绿
- [x] `[docs]` 设置描述 / README / ARCHITECTURE 路径更新；TESTING 地图与计数；021 验证记录

## 阶段 3 · 发布（需确认）

- [ ] `CHANGELOG` + 版本号 + tag
