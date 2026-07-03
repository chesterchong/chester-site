"use client"

import { motion } from "framer-motion"
import { useState } from "react"
import { RotateCcw } from "lucide-react"

// A simple animated "signature" for Chester. The original site drew a
// handwritten SVG; until you trace your own (e.g. with a tool like
// https://kalligraphic.vercel.app or Figma's pencil + SVG export), this
// renders your name in a script font with a fade-and-underline animation.
export default function Component() {
  const [key, setKey] = useState(0)
  const name = "Chester"

  return (
    <div className="flex flex-col items-end gap-2">
      <motion.svg
        key={key}
        width="284.768"
        height="70.487"
        viewBox="0 0 284.768 70.487"
        className="w-full max-w-xl text-stone-700 dark:text-stone-500"
      >
        <motion.text
          x="142"
          y="45"
          textAnchor="middle"
          fill="currentColor"
          fontSize="48"
          fontFamily="'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive"
        >
          {name.split("").map((letter, i) => (
            <motion.tspan
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.3 + i * 0.25 }}
            >
              {letter}
            </motion.tspan>
          ))}
        </motion.text>
        <motion.path
          d="M 2 65 C 50 65, 100 62, 284 62"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 0.2 }}
          transition={{
            pathLength: { duration: 1.5, ease: "easeInOut", delay: 2.2 },
            opacity: { duration: 0.5, delay: 2.2 }
          }}
        />
      </motion.svg>
      <motion.button
        onClick={() => setKey(k => k + 1)}
        aria-label="Replay signature animation"
        className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 3 }}
      >
        <RotateCcw size={16} />
      </motion.button>
    </div>
  )
}
