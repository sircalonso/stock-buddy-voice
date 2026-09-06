ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_platform_check;
ALTER TABLE public.sales ADD CONSTRAINT sales_platform_check CHECK (platform IN ('wallapop','vinted','almacen'));