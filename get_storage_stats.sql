-- ═══════════════════════════════════════════════════════════════════════
-- แก้ปัญหา Egress เกินโควตา (ส่วนที่ 2/2)
-- ═══════════════════════════════════════════════════════════════════════
-- ปัญหาเดิม: หน้า "Storage Status" ใน Admin Panel เคยคำนวณขนาดพื้นที่จัดเก็บ
-- โดยดึงข้อมูลทุกแถวทุกตารางออกมา (SELECT *) รวมถึงตาราง history ที่มีรูปถ่าย
-- แนบเป็น base64 อยู่ในทุกแถว แล้วเอามาชั่งน้ำหนักไบต์ฝั่ง browser
-- เท่ากับ "ดาวน์โหลดข้อมูลทั้งฐานทุกครั้ง" แค่เพื่อจะรู้ว่าฐานมันหนักแค่ไหน
--
-- Migration นี้สร้างฟังก์ชัน get_storage_stats() ให้ Postgres คำนวณขนาด
-- ตารางจริงด้วย pg_total_relation_size() ที่ฝั่งเซิร์ฟเวอร์เลย — ไม่มีข้อมูล
-- แถวไหนถูกส่งออกมาที่ browser แม้แต่ไบต์เดียว ทั้งเร็วกว่ามากและประหยัด
-- Egress เกือบทั้งหมดเมื่อเทียบกับวิธีเดิม
--
-- วิธีใช้: Copy ทั้งไฟล์นี้ไปรันใน Supabase Dashboard → SQL Editor → Run
-- รันครั้งเดียวพอ (ปลอดภัยที่จะรันซ้ำได้ด้วย เพราะใช้ CREATE OR REPLACE)
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.get_storage_stats()
returns table (
  table_name text,
  row_count  bigint,
  size_bytes bigint
)
language sql
security definer
set search_path = public
as $$
  select 'departments'::text, count(*), pg_total_relation_size('public.departments')
    from public.departments
  union all
  select 'lines'::text, count(*), pg_total_relation_size('public.lines')
    from public.lines
  union all
  select 'jigs'::text, count(*), pg_total_relation_size('public.jigs')
    from public.jigs
  union all
  select 'checkpoints'::text, count(*), pg_total_relation_size('public.checkpoints')
    from public.checkpoints
  union all
  select 'history'::text, count(*), pg_total_relation_size('public.history')
    from public.history
  union all
  select 'templates'::text, count(*), pg_total_relation_size('public.templates')
    from public.templates;
$$;

-- อนุญาตให้แอป (ที่เรียกผ่าน anon key ฝั่ง client) เรียกฟังก์ชันนี้ได้
-- หมายเหตุ: ฟังก์ชันนี้คืนแค่ "จำนวนแถว + ขนาดรวมเป็นไบต์" ต่อ 1 ตาราง
-- ไม่มีข้อมูลเนื้อหาจริงในแถวใดๆ หลุดออกมาเลย จึงไม่กระทบความปลอดภัยของข้อมูล
grant execute on function public.get_storage_stats() to anon, authenticated;
