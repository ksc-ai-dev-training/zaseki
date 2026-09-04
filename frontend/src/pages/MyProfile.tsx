import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useMyProfile } from '../hooks/useMyProfile'
import { useMe } from '../hooks/useMe'
import Modal from '../components/Modal'

// 保存する画像はCROP_SIZEの円形ビューポートで見えている範囲をOUTPUT_SIZE四方に描き直したJPEGに
// 統一する（2026-09-02追加。「アイコンが自動的に中央で切り抜かれるので、自分でズーム・位置を
// 調整できるようにしてほしい」との要望を受けた。以前はアップロードしたファイルをそのまま
// data URLとして保存し、表示側のobject-coverによる中央切り抜きに委ねていた）
const MAX_AVATAR_BYTES = 300 * 1024
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const CROP_SIZE = 224
const OUTPUT_SIZE = 240
const MIN_ZOOM = 1
const MAX_ZOOM = 3
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return Math.ceil((base64.length * 3) / 4)
}

function clampOffset(x: number, y: number, dispW: number, dispH: number): { x: number; y: number } {
  const minX = Math.min(0, CROP_SIZE - dispW)
  const minY = Math.min(0, CROP_SIZE - dispH)
  return { x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) }
}

// うるう年（2028年）を基準に、年を持たない月日の日数上限を求める（2/29を許容するため。バックエンドと同じ考え方）
function daysInMonth(month: number): number {
  return new Date(2028, month, 0).getDate()
}

// S-12 マイプロフィール。自分のアイコン（任意の画像）・生年月日（月日のみ、任意）を登録・編集する
// （要件定義書4.8節、FR-08-1・FR-08-2）
export default function MyProfile() {
  const { profile, isLoading, mutate: mutateProfile } = useMyProfile()
  const { me, mutate: mutateMe } = useMe()

  const [avatarImage, setAvatarImage] = useState<string | null>(null)
  const [birthMonth, setBirthMonth] = useState<number | null>(null)
  const [birthDay, setBirthDay] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // アイコンの位置・拡大率を調整するモーダル（S-12）の状態
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const cropImgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null)

  const baseScale = natural ? Math.max(CROP_SIZE / natural.w, CROP_SIZE / natural.h) : 1
  const scale = baseScale * zoom
  const dispW = natural ? natural.w * scale : 0
  const dispH = natural ? natural.h * scale : 0

  useEffect(() => {
    if (!profile) return
    setAvatarImage(profile.avatar_image)
    setBirthMonth(profile.birth_month)
    setBirthDay(profile.birth_day)
  }, [profile])

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('画像はJPEG・PNG・GIF・WebP形式でアップロードしてください')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('画像は10MB以下のファイルを選択してください')
      return
    }
    setError(null)
    setNatural(null)
    setZoom(MIN_ZOOM)
    setOffset({ x: 0, y: 0 })
    const reader = new FileReader()
    reader.onload = () => setCropSrc(reader.result as string)
    reader.readAsDataURL(file)
  }

  const onCropImageLoad = () => {
    const img = cropImgRef.current
    if (!img) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    const initialScale = Math.max(CROP_SIZE / w, CROP_SIZE / h)
    setNatural({ w, h })
    setOffset({ x: (CROP_SIZE - w * initialScale) / 2, y: (CROP_SIZE - h * initialScale) / 2 })
  }

  const onZoomChange = (nextZoom: number) => {
    if (!natural) { setZoom(nextZoom); return }
    const oldDispW = natural.w * scale
    const oldDispH = natural.h * scale
    const fracX = (CROP_SIZE / 2 - offset.x) / oldDispW
    const fracY = (CROP_SIZE / 2 - offset.y) / oldDispH
    const newScale = baseScale * nextZoom
    const newDispW = natural.w * newScale
    const newDispH = natural.h * newScale
    setZoom(nextZoom)
    setOffset(clampOffset(CROP_SIZE / 2 - fracX * newDispW, CROP_SIZE / 2 - fracY * newDispH, newDispW, newDispH))
  }

  const onCropPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffsetX: offset.x, startOffsetY: offset.y }
  }

  const onCropPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !natural) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setOffset(clampOffset(dragRef.current.startOffsetX + dx, dragRef.current.startOffsetY + dy, dispW, dispH))
  }

  const onCropPointerUp = () => { dragRef.current = null }

  const cancelCrop = () => { setCropSrc(null); dragRef.current = null }

  const confirmCrop = () => {
    const img = cropImgRef.current
    if (!img || !natural) return
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const sx = -offset.x / scale
    const sy = -offset.y / scale
    const sSize = CROP_SIZE / scale
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)

    let quality = 0.85
    let dataUrl = canvas.toDataURL('image/jpeg', quality)
    while (dataUrlByteLength(dataUrl) > MAX_AVATAR_BYTES && quality > 0.3) {
      quality -= 0.15
      dataUrl = canvas.toDataURL('image/jpeg', quality)
    }
    if (dataUrlByteLength(dataUrl) > MAX_AVATAR_BYTES) {
      setError('画像の保存に失敗しました。別の画像でお試しください')
      return
    }
    setAvatarImage(dataUrl)
    setSaved(false)
    setCropSrc(null)
  }

  const onMonthChange = (value: string) => {
    setSaved(false)
    const month = value === '' ? null : Number(value)
    setBirthMonth(month)
    if (month !== null && birthDay !== null && birthDay > daysInMonth(month)) {
      setBirthDay(daysInMonth(month))
    }
  }

  const save = async () => {
    setSubmitting(true)
    setError(null)
    setSaved(false)
    try {
      await apiFetch('/api/users/me/profile', {
        method: 'PUT',
        body: JSON.stringify({ avatar_image: avatarImage, birth_month: birthMonth, birth_day: birthDay }),
      })
      await Promise.all([mutateProfile(), mutateMe()])
      setSaved(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">マイプロフィール</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-12</span>
      </header>

      <div className="max-w-md p-6">
        {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

        {!isLoading && (
          <div className="rounded border border-slate-200 bg-white p-5">
            <div className="mb-6">
              <div className="mb-2 text-sm font-semibold text-slate-700">アイコン（任意）</div>
              <div className="flex items-center gap-4">
                {avatarImage ? (
                  <img src={avatarImage} alt="アイコン" className="h-16 w-16 rounded-full border border-slate-200 object-cover" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-200 text-xl font-semibold text-slate-600">
                    {me?.last_name?.slice(0, 1) ?? '?'}
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <label className="cursor-pointer rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                    画像を選択
                    <input type="file" accept={ACCEPTED_TYPES.join(',')} onChange={onFileChange} className="hidden" />
                  </label>
                  {avatarImage && (
                    <button
                      type="button"
                      onClick={() => { setAvatarImage(null); setSaved(false) }}
                      className="text-xs text-slate-500 underline hover:text-slate-700"
                    >
                      画像を削除する
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-400">JPEG・PNG・GIF・WebP形式、10MB以下。選択すると位置・拡大率を調整する画面が開きます。未設定の場合は氏名の頭文字で表示されます。</p>
            </div>

            <div className="mb-6">
              <div className="mb-2 text-sm font-semibold text-slate-700">生年月日（月日のみ、任意）</div>
              <div className="flex items-center gap-2">
                <select
                  value={birthMonth ?? ''}
                  onChange={(e) => onMonthChange(e.target.value)}
                  className="h-9 rounded border border-slate-300 px-2 text-sm"
                >
                  <option value="">月</option>
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>{m}月</option>
                  ))}
                </select>
                <select
                  value={birthDay ?? ''}
                  onChange={(e) => { setSaved(false); setBirthDay(e.target.value === '' ? null : Number(e.target.value)) }}
                  disabled={birthMonth === null}
                  className="h-9 rounded border border-slate-300 px-2 text-sm disabled:opacity-50"
                >
                  <option value="">日</option>
                  {Array.from({ length: birthMonth ? daysInMonth(birthMonth) : 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}日</option>
                  ))}
                </select>
                {(birthMonth !== null || birthDay !== null) && (
                  <button
                    type="button"
                    onClick={() => { setBirthMonth(null); setBirthDay(null); setSaved(false) }}
                    className="text-xs text-slate-500 underline hover:text-slate-700"
                  >
                    未設定に戻す
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                年は登録しません。登録すると、その月日に空き状況・予約（S-02）の座席タイルに誕生日であることが表示されます。
              </p>
            </div>

            {error && <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            {saved && !error && <p className="mb-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">保存しました。</p>}

            <button
              type="button"
              disabled={submitting}
              onClick={save}
              className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white hover:bg-blue-900 disabled:opacity-50"
            >
              保存する
            </button>
          </div>
        )}
      </div>

      {cropSrc && (
        <Modal
          title="アイコンの位置・拡大率を調整"
          onClose={cancelCrop}
          footer={
            <>
              <button type="button" onClick={cancelCrop} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" onClick={confirmCrop} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white hover:bg-blue-900">適用する</button>
            </>
          }
        >
          <div className="flex flex-col items-center gap-4">
            <div
              className="relative touch-none overflow-hidden rounded-full border border-slate-300 bg-slate-100"
              style={{ width: CROP_SIZE, height: CROP_SIZE, cursor: 'grab' }}
              onPointerDown={onCropPointerDown}
              onPointerMove={onCropPointerMove}
              onPointerUp={onCropPointerUp}
              onPointerLeave={onCropPointerUp}
            >
              <img
                ref={cropImgRef}
                src={cropSrc}
                onLoad={onCropImageLoad}
                draggable={false}
                alt=""
                style={{
                  position: 'absolute',
                  left: offset.x,
                  top: offset.y,
                  width: dispW || undefined,
                  height: dispH || undefined,
                  maxWidth: 'none',
                }}
              />
            </div>
            <label className="flex w-full items-center gap-2 text-xs text-slate-500">
              拡大
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                onChange={(e) => onZoomChange(Number(e.target.value))}
                className="flex-1"
              />
            </label>
            <p className="text-xs text-slate-400">ドラッグして位置を調整できます。</p>
          </div>
        </Modal>
      )}
    </div>
  )
}
