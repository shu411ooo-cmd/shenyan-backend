-- 留痕 v1：keepalive 唤醒的 thoughts（内心想法）落库。
-- 现状缺口：模型按唤醒指令输出了 thoughts，但 runKeepalive 从不接出/落库，无痕缺口。
-- 修复：加 thoughts 列，none 也写（「为什么选 none」本身是内容）；下次唤醒注入让沈晏知道自己醒过。
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS thoughts text;
