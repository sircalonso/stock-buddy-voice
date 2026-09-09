ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_platform_check;
ALTER TABLE public.sales ADD CONSTRAINT sales_platform_check CHECK (platform IN ('wallapop','vinted','almacen','fba'));

CREATE TABLE public.fba_reservations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fba_reservations TO authenticated;
GRANT ALL ON public.fba_reservations TO service_role;

ALTER TABLE public.fba_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fba_own_select" ON public.fba_reservations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "fba_own_insert" ON public.fba_reservations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "fba_own_update" ON public.fba_reservations FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "fba_own_delete" ON public.fba_reservations FOR DELETE TO authenticated USING (auth.uid() = user_id);