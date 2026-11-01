-- 重建开发库：清空 public schema，让 001–003 可以重复执行
-- 仅用于本地开发，不要在已有生产数据的库上跑。
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
