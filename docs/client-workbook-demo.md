# Client workbook demonstration

Source: `resource/sheets/Sistem_Manajemen_Pesanan_dan_Stok.xlsx` in the parent project.
Structure reference: https://www.techs-s.com/media/show/7 (structure BOM: product, component, raw material).

`tool/prepare-client-workbook-demo.py` generates `backend/supabase/seed_client_workbook.sql`.
The seed adds examples once and preserves subsequent edits when run again.
It uses database-generated IDs and resolves relationships using source business codes.

## Included records

- 10 inventory items with the workbook's codes, opening quantities, categories,
  procurement methods, units, suppliers, costs, minimum and target quantities.
- 2 customer masters. Invalid phone placeholders are left blank.
- 3 product masters: FG-A001 / Bracket assembly A, FG-B001 / Sensor mount B,
  and CP-001 / Bracket mentah. The component has no sales price in the workbook,
  so its product price is zero. Task durations convert hours to minutes.
- 6 BOM rows representing the workbook's 5 parent/child relationships. CP-001's
  raw-material edge appears inside FG-B001's tree and in CP-001's standalone BOM.
- 4 purchases, with 3 automatic stock receipts, and 13 other stock movements.
  Purchase receipts are not imported twice from the movement sheet.
- 4 sales orders. Active orders show their outstanding quantities and values;
  notes retain original ordered/shipped quantities. SO-26-004 is cancelled.

```text
FG-A001 Bracket assembly A
  OP-001 Bracket anodisasi x2
  BP-001 Baut M6 x4

FG-B001 Sensor mount B
  CP-001 Bracket mentah x1
    RM-001 Pelat aluminium x0.5 kg
  BP-002 Bearing 608 x1

CP-001 Bracket mentah (separate production)
  RM-001 Pelat aluminium x0.5 kg
```

Production issues only the root product's direct components. Produce intermediate
components separately using their own product BOM, and record output through
Inventory > Movements. Existing production snapshots retain their original requirements.

## Open the examples

- Inventory / 在庫: find `FG-001`, `CP-001`, or `RM-001`.
- Product materials (BOM) / 製品材料（BOM）: FG-B001 shows CP-001 with RM-001 indented below it.
  Select FG-B001 in Product, then CP-001 in Parent assembly to add another child there.
- Purchases / 仕入: PO-26-001 through PO-26-004 show received, partial and cancelled examples.
- Search & billing / 検索・請求: use the date range 2026-09-01 to 2026-09-30
  to find SO-26-001 through SO-26-004. Enable Cancelled if supported by the current filter.

## Verification

Expected ready stock: FG-001=2, FG-002=2, CP-001=8, OP-001=2,
RM-001=70, RM-002=25, BP-001=104, BP-002=4, CS-001=3, CS-002=4.
Sample stock value: JPY 77,680. Active outstanding sales: JPY 107,600.

Run `backend/supabase/tests/client_workbook_bom.sql` for an authenticated-role,
transactional verification. All of its test writes roll back.

The app does not have separate WO, WIP, scrap, stock-count or subcontract-job
modules. Their stock-changing examples are represented in Movements with the
original WO/SUB references; zero-stock-change start/scrap events are not ledger
entries. Source WIP and open supply/demand calculations are not recreated by this seed.
