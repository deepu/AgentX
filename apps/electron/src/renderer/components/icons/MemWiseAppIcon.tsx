import memwiseLogo from "@/assets/memwise_logo_m.svg"

interface MemWiseAppIconProps {
  className?: string
  size?: number
}

/**
 * MemWiseAppIcon - Displays the MemWise logo (purple "M" monogram)
 */
export function MemWiseAppIcon({ className, size = 64 }: MemWiseAppIconProps) {
  return (
    <img
      src={memwiseLogo}
      alt="MemWise"
      width={size}
      height={size}
      className={className}
    />
  )
}
