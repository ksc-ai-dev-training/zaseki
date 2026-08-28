// S-02のフロアマップ（FloorAreas.tsx）は実際のオフィス配置図をそのまま再現した固定レイアウトで、
// 座席の位置は座席番号ごとに手作業で配置されている（backend/seed.pyのAREA_BLOCKSと対応）。
// S-07から新しく追加した座席はこの固定レイアウトに含まれないため、フロアマップの図には現れない。
// この一覧は「図に既に配置されている座席番号」を判定し、それ以外を「追加座席」として
// 別枠に一覧表示するために使う（Availability.tsx参照）。
const AREA_BLOCKS: Record<'NORTH' | 'EAST' | 'WEST', [string, number][]> = {
  NORTH: [['A', 11], ['B', 8]],
  EAST: [['C', 4], ['D', 4], ['E', 4], ['F', 8], ['G', 4], ['H', 4], ['I', 4]],
  WEST: [['J', 4], ['K', 4], ['L', 4], ['M', 8], ['N', 4], ['O', 4], ['P', 4]],
}

function expand(blocks: [string, number][]): string[] {
  return blocks.flatMap(([letter, count]) => Array.from({ length: count }, (_, i) => `${letter}${i + 1}`))
}

export const FLOOR_LAYOUT_SEATS: Record<'NORTH' | 'EAST' | 'WEST', Set<string>> = {
  NORTH: new Set(expand(AREA_BLOCKS.NORTH)),
  EAST: new Set(expand(AREA_BLOCKS.EAST)),
  WEST: new Set(expand(AREA_BLOCKS.WEST)),
}

// 座席番号の英字プレフィックス（block）を取り出す。backend/routers/seats.pyの_block_labelと同じ考え方
export function blockLabelOf(seatNo: string): string {
  const m = /^([A-Za-z]+)/.exec(seatNo)
  return m ? `${m[1]}ブロック` : seatNo
}
