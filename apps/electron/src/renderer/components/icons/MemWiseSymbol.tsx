interface MemWiseSymbolProps {
  className?: string
}

/**
 * MemWise "M" symbol - the small pixel-style monogram
 * Uses accent color from theme (currentColor from className)
 */
export function MemWiseSymbol({ className }: MemWiseSymbolProps) {
  return (
    <svg
      viewBox="452 368 115 129"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M452.1667,368 L499.9447,368 L499.9447,393.8 L519.0553,393.8 L519.0553,368 L566.8333,368 L566.8333,497 L538.1667,497 L538.1667,419.6 L519.0553,419.6 L519.0553,445.4 L499.9447,445.4 L499.9447,419.6 L480.8333,419.6 L480.8333,497 L452.1667,497 Z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  )
}
