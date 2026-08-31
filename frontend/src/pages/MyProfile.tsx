import { useEffect, useState, type ChangeEvent } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useMyProfile } from '../hooks/useMyProfile'
import { useMe } from '../hooks/useMe'

const MAX_AVATAR_BYTES = 300 * 1024
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

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
    setSaved(false)
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('画像はJPEG・PNG・GIF・WebP形式でアップロードしてください')
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError('画像は300KB以下のファイルを選択してください')
      return
    }
    setError(null)
    const reader = new FileReader()
    reader.onload = () => setAvatarImage(reader.result as string)
    reader.readAsDataURL(file)
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
              <p className="mt-2 text-xs text-slate-400">JPEG・PNG・GIF・WebP形式、300KB以下。未設定の場合は氏名の頭文字で表示されます。</p>
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
    </div>
  )
}
