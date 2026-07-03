import { GeistSans } from "geist/font/sans";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import Header from "./components/Header";
import Footer from "./components/Footer";
import dynamic from "next/dynamic";
import ThemeProvider from "./components/ThemeProvider";

const CommandPalette = dynamic(() => import("./components/CommandPalette"), {
  ssr: false,
});

const SuminagashiBackground = dynamic(
  () => import("./components/SuminagashiBackground"),
  { ssr: false }
);

export const metadata = {
  title: "Chester Chong",
  // update if you attach a custom domain
  metadataBase: new URL("https://chester-site-one.vercel.app"),
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${GeistSans.className} bg-[#f0ece3] dark:bg-[#0e0d0c]`}>
        <SpeedInsights />
        <ThemeProvider>
          <SuminagashiBackground />
          <main className="flex justify-center font-extralight min-h-screen selection:bg-transparent">
            <div className="flex flex-col gap-4 w-full md:max-w-[500px] m-6 md:m-20 text-neutral-500 dark:text-neutral-400 md:mt-[60px]">
              <Header />
              {children}
              <Footer />
            </div>
          </main>
          <CommandPalette />
        </ThemeProvider>
      </body>
    </html>
  );
}
