"use client";

import Link from "./components/Link";
import NextLink from "next/link";
import dynamic from "next/dynamic";
const Signature = dynamic(() => import("@/app/components/Signature"), {
  ssr: false,
});
import PolymarketLogo from "@/app/components/icon/Polymarket.png";
import TARUMTLogo from "@/app/components/icon/TARUMT.png";
import MEXCLogo from "@/app/components/icon/MEXC.png";
import RadexMarketsLogo from "@/app/components/icon/RadexMarkets.png";
import InnovmetaLogo from "@/app/components/icon/Innovmeta.png";
import Image from "next/image";
import { GalleryHorizontalEnd } from "lucide-react";

export default function About() {
  return (
    <div className="flex flex-col w-full font-extralight">
      <ul className="grid gap-1 text-base">
        <li className="group flex items-start gap-4 pl-4 relative hover:translate-x-1 transition-transform duration-200">
          <div className="absolute left-0 top-[10px] w-[6px] h-[6px] bg-stone-800 dark:bg-stone-200 rotate-45 transform transition-all duration-300 group-hover:rotate-90 group-hover:scale-110" />
          <span className="text-stone-600 dark:text-stone-400">
            Defi
            <span className="inline-flex items-baseline gap-1 ml-2">
              <Image
                src={PolymarketLogo}
                alt="Polymarket Logo"
                width={14}
                height={14}
                className="object-contain relative top-[2px]"
              />
              <Link href="https://polymarket.com" className="font-medium">
                Polymarket
              </Link>
            </span>
          </span>
        </li>
        <li className="group flex items-start gap-4 pl-4 relative hover:translate-x-1 transition-transform duration-200">
          <div className="absolute left-0 top-[10px] w-[6px] h-[6px] bg-stone-800 dark:bg-stone-200 rotate-45 transform transition-all duration-300 group-hover:rotate-90 group-hover:scale-110" />
          <span className="text-stone-600 dark:text-stone-400">
            CS
            <span className="inline-flex items-baseline gap-1 ml-2">
              <Image
                src={TARUMTLogo}
                alt="TARUMT Logo"
                width={14}
                height={14}
                className="object-contain relative top-[2px]"
              />
              <Link href="https://www.tarc.edu.my/" className="font-medium">
                TARUMT
              </Link>
            </span>
          </span>
        </li>
        <li className="group flex flex-col gap-3 pl-4 relative hover:translate-x-1 transition-transform duration-200">
          <div className="absolute left-0 top-[10px] w-[6px] h-[6px] bg-stone-800 dark:bg-stone-200 rotate-45 transform transition-all duration-300 group-hover:rotate-90 group-hover:scale-110" />
          <span className="text-stone-600 dark:text-stone-400 italic font-medium">
            what i&apos;ve been building:
          </span>
          <ul className="grid gap-1 pl-4">
            <li className="relative flex items-start gap-4 group/item">
              <span className="absolute left-[-20px] top-0 text-stone-500 dark:text-stone-500">
                ↳
              </span>
              <span className="text-stone-600 dark:text-stone-400">
                built an{" "}
                <span className="font-medium text-stone-800 dark:text-stone-200">
                  AI wrapper for quizzes
                </span>{" "}
                from scratch in &lt; 2 days
              </span>
            </li>
          </ul>
        </li>
        <li className="group flex flex-col gap-3 pl-4 relative hover:translate-x-1 transition-transform duration-200">
          <div className="absolute left-0 top-[10px] w-[6px] h-[6px] bg-stone-800 dark:bg-stone-200 rotate-45 transform transition-all duration-300 group-hover:rotate-90 group-hover:scale-110" />
          <span className="text-stone-600 dark:text-stone-400 italic font-medium">
            previously:
          </span>
          <ul className="grid gap-1 pl-4">
            <li className="relative flex items-start gap-4 group/item">
              <span className="absolute left-[-20px] top-0 text-stone-500 dark:text-stone-500">
                ↳
              </span>
              <span className="text-stone-600 dark:text-stone-400">
                CX
                <span className="inline-flex items-baseline gap-1 ml-2">
                  <Image
                    src={MEXCLogo}
                    alt="MEXC Logo"
                    width={14}
                    height={14}
                    className="object-contain relative top-[2px]"
                  />
                  <Link href="https://www.mexc.com" className="font-medium">
                    MEXC
                  </Link>
                </span>
              </span>
            </li>
            <li className="relative flex items-start gap-4 group/item">
              <span className="absolute left-[-20px] top-0 text-stone-500 dark:text-stone-500">
                ↳
              </span>
              <span className="text-stone-600 dark:text-stone-400">
                KYC Op
                <span className="inline-flex items-baseline gap-1 ml-2">
                  <Image
                    src={RadexMarketsLogo}
                    alt="Radex Markets Logo"
                    width={14}
                    height={14}
                    className="object-contain relative top-[2px]"
                  />
                  <Link href="https://www.radexmarkets.com" className="font-medium">
                    Radex Markets
                  </Link>
                </span>
              </span>
            </li>
            <li className="relative flex items-start gap-4 group/item">
              <span className="absolute left-[-20px] top-0 text-stone-500 dark:text-stone-500">
                ↳
              </span>
              <span className="text-stone-600 dark:text-stone-400">
                Engineering
                <span className="inline-flex items-baseline gap-1 ml-2">
                  <Image
                    src={InnovmetaLogo}
                    alt="Innovmeta Logo"
                    width={14}
                    height={14}
                    className="object-contain relative top-[2px]"
                  />
                  <Link href="https://innovmeta.my" className="font-medium">
                    Innovmeta
                  </Link>
                </span>
              </span>
            </li>
          </ul>
        </li>
      </ul>

      <NextLink
        href="/projects"
        className="text-center mt-4 py-4 px-6 rounded-lg border border-stone-500/50 dark:border-stone-600/60 bg-white/25 dark:bg-white/[0.06] backdrop-blur-[2px] text-stone-700 dark:text-stone-300 transform transition-all duration-300 font-extralight hover:scale-[1.02] hover:bg-white/40 dark:hover:bg-white/10 active:scale-[0.98]"
      >
        see what i&apos;ve built{" "}
        <GalleryHorizontalEnd className="size-5 inline align-top ml-1 transition-transform group-hover:rotate-3" />
      </NextLink>

      <div className="flex flex-col sm:flex-row items-center justify-end mt-8">
        <Signature />
      </div>
    </div>
  );
}
