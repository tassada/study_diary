import { useState } from 'react'
import { GirlAvatarSprite, PixelStarBadge, StellaTeacherSprite } from '../components/PixelSprites'
import type { ChildProfile } from '../types/study'

interface ChildEntryGateProps {
  profiles: ChildProfile[]
  loading: boolean
  errorMsg: string | null
  onRetry: () => void
  onEnterChildSpace: (child: ChildProfile) => void
}

export function ChildEntryGate({
  profiles,
  loading,
  errorMsg,
  onRetry,
  onEnterChildSpace,
}: ChildEntryGateProps) {
  const [showCertGuide, setShowCertGuide] = useState(false)
  const isNativeApp = typeof window !== 'undefined' && window.location.protocol === 'capacitor:'

  return (
    <div className="relative w-full h-full p-7 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-3 bg-[#EC5F9B] border-3 border-[#4A2B44] px-4 py-2 text-white shadow-[3px_3px_0_#4A2B44] rounded">
          <span className="text-[22px] font-extrabold tracking-wide">★ 星莓伴学日记</span>
        </div>

        {!isNativeApp && (
          <button
            type="button"
            onClick={() => setShowCertGuide(true)}
            className="pixel-btn bg-[#FFFDF9] px-3.5 py-2 text-[15px] font-bold text-[#332230]"
          >
            📲 安装到 iPad
          </button>
        )}
      </div>

      <div className="max-w-[960px] w-full mx-auto my-auto text-center space-y-7">
        <div className="inline-flex items-center gap-3.5 bg-[#FFFDF9] border-3 border-[#4A2B44] rounded-md px-6 py-3.5 shadow-[4px_4px_0_#EB9EC2]">
          <StellaTeacherSprite size={48} />
          <h1 className="text-[24px] font-extrabold text-[#332230]">
            欢迎回来！请选择进入专属学习空间
          </h1>
        </div>

        {loading ? (
          <div className="pixel-card p-10 text-[20px] font-extrabold text-[#5C4056]">
            ✨ 正在连接服务器加载小朋友档案，请稍候...
          </div>
        ) : errorMsg ? (
          <div className="pixel-card-pink p-8 space-y-4">
            <div className="text-[19px] font-extrabold text-[#B51D5B]">⚠️ {errorMsg}</div>
            <button
              type="button"
              onClick={onRetry}
              className="pixel-btn bg-[#FFE484] px-6 py-3 text-[18px] font-extrabold"
            >
              🔄 重新连接服务器
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-6">
            {profiles.map((child) => (
              <div
                key={child.id}
                onClick={() => onEnterChildSpace(child)}
                className="pixel-card-pink w-[420px] p-6 cursor-pointer hover:brightness-[1.01] transition-transform active:translate-y-1 text-left flex flex-col justify-between gap-5"
              >
                <div className="flex items-center gap-4">
                  <div className="border-3 border-[#4A2B44] bg-white p-1.5 rounded">
                    <GirlAvatarSprite avatar={child.avatarKey} size={76} />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[28px] font-extrabold text-[#332230]">
                        {child.displayName}
                      </span>
                      <span className="text-[14px] bg-[#EC5F9B] text-white px-2.5 py-0.5 rounded font-bold">
                        {child.gender} · {child.age}岁
                      </span>
                    </div>
                    <div className="text-[17px] font-bold text-[#5C4056]">{child.gradeLabel}</div>
                    <div className="text-[14px] font-semibold text-[#7A5672] font-num">
                      🎂 生日：{child.birthDate}
                    </div>
                  </div>
                </div>

                <div className="bg-[#FFFDF9] border-2 border-[#4A2B44] rounded p-3 flex items-center justify-between">
                  <span className="text-[15px] font-bold text-[#5C4056]">{child.titleBadge}</span>
                  <span className="font-num text-[18px] font-extrabold text-[#B56B00] flex items-center gap-1">
                    <PixelStarBadge size={16} />
                    {child.starCoins} 币
                  </span>
                </div>

                <button
                  type="button"
                  className="pixel-btn w-full bg-[#FFE484] text-[#332230] py-3.5 text-[21px] font-extrabold text-center"
                >
                  ✨ 进入 {child.displayName} 的学习手账 ▶
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="h-2" />

      {showCertGuide && (
        <div className="absolute inset-0 z-50 bg-[#2A1829]/65 p-8 flex items-center justify-center">
          <div className="pixel-card max-w-[740px] w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b-3 border-[#4A2B44] pb-3">
              <h3 className="text-[22px] font-extrabold text-[#332230]">
                📲 一键安装「星莓伴学」到 iPad 主屏幕
              </h3>
              <button
                type="button"
                onClick={() => setShowCertGuide(false)}
                className="pixel-btn bg-[#FFFDF9] px-4 py-1.5 text-[16px] font-bold"
              >
                ✕ 关闭
              </button>
            </div>
            <div className="space-y-2.5 text-[17px] leading-relaxed text-[#332230]">
              <ol className="list-decimal pl-6 space-y-2 font-semibold">
                <li>
                  在 iPad 自带 <b>Safari 浏览器</b> 点击下方绿色按钮（或访问{' '}
                  <code>{`${window.location.origin}/ipad`}</code>），在弹窗中点「允许」。
                </li>
                <li>
                  打开 iPad「设置 → 已下载描述文件」点击<b>安装</b>（会同时装好桌面全屏图标与语音安全证书）。
                </li>
                <li>
                  打开「设置 → 通用 → 关于本机 → 证书信任设置」，开启{' '}
                  <code>Caddy Local Authority</code> 完全信任开关，回到桌面点击「星莓伴学」图标即可全屏使用！
                </li>
              </ol>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <a
                href="/cert/caddy-root.crt"
                download="studydiary-root-ca.crt"
                className="pixel-btn bg-[#FFFDF9] text-[#332230] px-4 py-2.5 text-[15px] font-bold inline-block"
              >
                仅下载根证书（安卓用）
              </a>
              <a
                href="/ipad"
                className="pixel-btn bg-[#52CE9B] text-[#104530] px-6 py-2.5 text-[18px] font-extrabold inline-block"
              >
                ⬇️ 一键安装到 iPad（桌面图标 + 语音证书）
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
