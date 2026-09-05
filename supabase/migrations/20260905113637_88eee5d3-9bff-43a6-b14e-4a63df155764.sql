ALTER TABLE public.products ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS products_user_idx ON public.products(user_id);
CREATE INDEX IF NOT EXISTS sales_user_idx ON public.sales(user_id);
CREATE INDEX IF NOT EXISTS alerts_user_idx ON public.alerts(user_id);

DROP POLICY IF EXISTS products_public_all ON public.products;
DROP POLICY IF EXISTS sales_public_all ON public.sales;
DROP POLICY IF EXISTS alerts_public_all ON public.alerts;

REVOKE ALL ON public.products FROM anon;
REVOKE ALL ON public.sales FROM anon;
REVOKE ALL ON public.alerts FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts TO authenticated;
GRANT ALL ON public.products TO service_role;
GRANT ALL ON public.sales TO service_role;
GRANT ALL ON public.alerts TO service_role;

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_own_select ON public.products FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY products_own_insert ON public.products FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY products_own_update ON public.products FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY products_own_delete ON public.products FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY sales_own_select ON public.sales FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY sales_own_insert ON public.sales FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY sales_own_update ON public.sales FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY sales_own_delete ON public.sales FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY alerts_own_select ON public.alerts FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY alerts_own_insert ON public.alerts FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY alerts_own_update ON public.alerts FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY alerts_own_delete ON public.alerts FOR DELETE TO authenticated USING (auth.uid() = user_id);