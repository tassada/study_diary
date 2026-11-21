import type { GirlAvatarKey, SubjectKey } from '../types/study'

export function GirlAvatarSprite({
  avatar,
  size = 44,
}: {
  avatar: GirlAvatarKey
  size?: number
}) {
  if (avatar === 'duoduo') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
        <rect width="16" height="16" fill="#FFE4F0" />
        <rect x="2" y="2" width="3" height="2" fill="#FF3D7F" />
        <rect x="11" y="2" width="3" height="2" fill="#FF3D7F" />
        <rect x="4" y="2" width="8" height="3" fill="#6D3B5E" />
        <rect x="1" y="4" width="3" height="8" fill="#6D3B5E" />
        <rect x="12" y="4" width="3" height="8" fill="#6D3B5E" />
        <rect x="3" y="4" width="10" height="2" fill="#854873" />
        <rect x="4" y="6" width="8" height="6" fill="#FFE2D4" />
        <rect x="5" y="8" width="2" height="2" fill="#3B1D36" />
        <rect x="9" y="8" width="2" height="2" fill="#3B1D36" />
        <rect x="5" y="8" width="1" height="1" fill="#FFFFFF" />
        <rect x="9" y="8" width="1" height="1" fill="#FFFFFF" />
        <rect x="4" y="10" width="2" height="1" fill="#FF85B3" />
        <rect x="10" y="10" width="2" height="1" fill="#FF85B3" />
        <rect x="7" y="10" width="2" height="1" fill="#E05288" />
        <rect x="4" y="12" width="8" height="4" fill="#FF6EA8" />
        <rect x="6" y="12" width="4" height="2" fill="#FFFFFF" />
      </svg>
    )
  }

  if (avatar === 'tangtang') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
        <rect width="16" height="16" fill="#F1E6FF" />
        <rect x="6" y="0" width="4" height="2" fill="#7C4DFF" />
        <rect x="4" y="2" width="8" height="2" fill="#7C4DFF" />
        <rect x="2" y="4" width="12" height="1" fill="#FFE066" />
        <rect x="3" y="5" width="10" height="6" fill="#4A326E" />
        <rect x="4" y="6" width="8" height="6" fill="#FFE6DA" />
        <rect x="5" y="8" width="2" height="2" fill="#311B52" />
        <rect x="9" y="8" width="2" height="2" fill="#311B52" />
        <rect x="5" y="8" width="1" height="1" fill="#FFFFFF" />
        <rect x="9" y="8" width="1" height="1" fill="#FFFFFF" />
        <rect x="4" y="10" width="2" height="1" fill="#FFB3D9" />
        <rect x="10" y="10" width="2" height="1" fill="#FFB3D9" />
        <rect x="7" y="10" width="2" height="1" fill="#D95B96" />
        <rect x="4" y="12" width="8" height="4" fill="#9B6BFF" />
        <rect x="7" y="13" width="2" height="2" fill="#FFE066" />
      </svg>
    )
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
      <rect width="16" height="16" fill="#E0FFF1" />
      <rect x="4" y="0" width="2" height="4" fill="#FFFFFF" />
      <rect x="10" y="0" width="2" height="4" fill="#FFFFFF" />
      <rect x="5" y="1" width="1" height="2" fill="#FF9EBB" />
      <rect x="10" y="1" width="1" height="2" fill="#FF9EBB" />
      <rect x="3" y="4" width="10" height="8" fill="#5FE3B0" />
      <rect x="4" y="6" width="8" height="6" fill="#FFE7DC" />
      <rect x="5" y="8" width="2" height="2" fill="#2A4038" />
      <rect x="9" y="8" width="2" height="2" fill="#2A4038" />
      <rect x="5" y="8" width="1" height="1" fill="#FFFFFF" />
      <rect x="9" y="8" width="1" height="1" fill="#FFFFFF" />
      <rect x="4" y="10" width="2" height="1" fill="#FF8FB8" />
      <rect x="10" y="10" width="2" height="1" fill="#FF8FB8" />
      <rect x="7" y="10" width="2" height="1" fill="#FF6B9D" />
      <rect x="4" y="12" width="8" height="4" fill="#46CC98" />
      <rect x="6" y="12" width="4" height="2" fill="#FFF7B2" />
    </svg>
  )
}

export function StellaTeacherSprite({
  talking = false,
  size = 56,
}: {
  talking?: boolean
  size?: number
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0 animate-pixel-float">
      <rect x="7" y="1" width="2" height="2" fill="#FFE066" />
      <rect x="6" y="3" width="4" height="2" fill="#FF94C2" />
      <rect x="2" y="5" width="12" height="3" fill="#FF7EB6" />
      <rect x="4" y="8" width="8" height="4" fill="#FF7EB6" />
      <rect x="3" y="12" width="3" height="3" fill="#FF63A5" />
      <rect x="10" y="12" width="3" height="3" fill="#FF63A5" />
      <rect x="5" y="6" width="6" height="5" fill="#FFF0F6" />
      <rect x="5" y="7" width="1" height="2" fill="#4A2545" />
      <rect x="10" y="7" width="1" height="2" fill="#4A2545" />
      <rect x="4" y="9" width="1" height="1" fill="#FF85B3" />
      <rect x="11" y="9" width="1" height="1" fill="#FF85B3" />
      {talking ? (
        <rect x="7" y="9" width="2" height="2" fill="#E03E7A" />
      ) : (
        <rect x="7" y="9" width="2" height="1" fill="#E03E7A" />
      )}
      <rect x="13" y="2" width="2" height="2" fill="#FFE066" />
      <rect x="14" y="4" width="1" height="4" fill="#C98A4B" />
    </svg>
  )
}

export function SubjectPixelIcon({
  subject,
  size = 28,
}: {
  subject: SubjectKey
  size?: number
}) {
  if (subject === 'chinese') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
        <rect x="3" y="2" width="10" height="12" fill="#FF6B98" />
        <rect x="4" y="3" width="8" height="10" fill="#FFF5F8" />
        <rect x="5" y="5" width="6" height="1" fill="#D9386A" />
        <rect x="5" y="7" width="6" height="1" fill="#D9386A" />
        <rect x="5" y="9" width="4" height="1" fill="#D9386A" />
        <rect x="10" y="10" width="2" height="4" fill="#FFE066" />
      </svg>
    )
  }
  if (subject === 'math') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
        <rect x="2" y="3" width="12" height="10" fill="#4A90E2" />
        <rect x="3" y="4" width="10" height="8" fill="#EBF5FF" />
        <rect x="4" y="6" width="2" height="2" fill="#FF7EB6" />
        <rect x="7" y="6" width="2" height="2" fill="#FFB84D" />
        <rect x="10" y="9" width="2" height="2" fill="#4FD1A5" />
        <rect x="5" y="9" width="2" height="2" fill="#5CA8FF" />
      </svg>
    )
  }
  if (subject === 'english') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
        <rect x="2" y="3" width="12" height="9" fill="#38C695" />
        <rect x="3" y="4" width="10" height="7" fill="#E8FFF6" />
        <rect x="5" y="6" width="2" height="3" fill="#1F8A65" />
        <rect x="8" y="6" width="3" height="3" fill="#FF7EB6" />
        <rect x="5" y="12" width="3" height="2" fill="#38C695" />
      </svg>
    )
  }
  if (subject === 'reading') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
        <rect x="2" y="3" width="6" height="10" fill="#A678FF" />
        <rect x="8" y="3" width="6" height="10" fill="#8C58F0" />
        <rect x="3" y="4" width="4" height="8" fill="#FAF5FF" />
        <rect x="9" y="4" width="4" height="8" fill="#F3E8FF" />
        <rect x="7" y="2" width="2" height="2" fill="#FFE066" />
      </svg>
    )
  }
  if (subject === 'science') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
        <rect x="6" y="2" width="4" height="3" fill="#82527B" />
        <rect x="4" y="5" width="8" height="8" fill="#7CE7FF" />
        <rect x="5" y="8" width="6" height="4" fill="#FFB84D" />
        <rect x="6" y="9" width="2" height="2" fill="#FFF7CC" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="pixel-sprite shrink-0">
      <rect x="3" y="3" width="10" height="10" fill="#FFB38A" />
      <rect x="5" y="5" width="2" height="2" fill="#FF6B98" />
      <rect x="9" y="5" width="2" height="2" fill="#5CA8FF" />
      <rect x="5" y="9" width="2" height="2" fill="#4FD1A5" />
      <rect x="9" y="9" width="2" height="2" fill="#A678FF" />
    </svg>
  )
}

export function PixelStarBadge({
  filled = true,
  size = 16,
}: {
  filled?: boolean
  size?: number
}) {
  const main = filled ? '#FFD43B' : '#E9D8E6'
  const edge = filled ? '#C98A00' : '#B59BB0'
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className="pixel-sprite inline-block">
      <rect x="5" y="1" width="2" height="2" fill={edge} />
      <rect x="2" y="4" width="8" height="3" fill={main} />
      <rect x="4" y="3" width="4" height="5" fill={main} />
      <rect x="3" y="8" width="2" height="3" fill={edge} />
      <rect x="7" y="8" width="2" height="3" fill={edge} />
    </svg>
  )
}
