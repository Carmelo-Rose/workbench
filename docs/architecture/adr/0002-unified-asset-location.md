# ADR 0002：素材位置显式字段，`assetId` 保持唯一外部标识

- 状态：已采纳
- 相关：[phase2-application-layer.md](../phase2-application-layer.md)

## 背景

图片/视频素材的字节可能存在三个地方：本地对象存储（`storage_key`）、外部直
链（`source_url`）、以及计划里要接的 Toolbox 网关 `fileId`/火山 TOS key。迁移
前只能靠"`storage_key` 是否非空"隐式推断"本地存储 vs 外部 URL"，Toolbox/TOS
这两种以后要接的情况完全没有位置记录。

## 决策

`mono_assets` 加一个显式 `location` 列（`local-storage`/`toolbox`/`tos`/
`remote-url`），老库按现有 `storage_key` 是否非空回填一次。所有调用方
（`mono_create_asset` 工具、`createStoredAsset`、聊天路由的素材登记）继续只
认 `assetId`，`location`/`storage_key`/`source_url` 是内部定位器，从不对外
暴露成需要调用方理解的概念。

**明确不做**：本轮不写任何创建 `toolbox`/`tos` location 资产的代码——这两个
枚举值目前只是类型定义好了，是给 Toolbox 副本自动创建、TOS 直传这些以后的
功能占位，用之前不会有任何代码路径产出这两种 location 的行。

## 后果

- 好处：以后接 Toolbox/TOS 只需要在 `createMonoAsset` 加一个创建分支，不需要
  再动 `assetId` 消费端的任何代码——素材身份和素材位置从一开始就是分开的两件
  事。
- 代价：多一列意味着多一种"这行数据现在处于什么状态"要考虑，虽然目前只有
  两种实际会出现的值。
- 已知限制：`location` 目前没有任何读路径依赖它（纯标注），可以随时 drop 或
  忽略这一列而不影响现有功能——这是刻意设计的低风险附加，不是半成品。
