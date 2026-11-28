"use client"
import Image from "next/image"
import WalletModal from "../WalletModal/WalletModal"
import TopBanner from "./TopBanner"
import EthereumWalletButton from "../EthereumWalletButton"
import MobileNav from "./Nav/MovileNav"
import DesktopNav from "./Nav/DesktopNav"
import Link from "next/link"

function Header() {
  return (
    <>
      <TopBanner />
      <header data-circuit-rail="header" className="circuit-rail grid grid-cols-2 xl:grid-cols-[auto_1fr_auto] xl:gap-4 items-center px-4 sm:px-8 py-4">
        <Link href="/" className="select-none hover:opacity-80 w-fit transition-colors focus-visible:outline-none ring-offset-accent focus-visible:ring-2 rounded focus-visible:ring-ring focus-visible:ring-offset-2">
          <Image src="/warp-green-logo.png" className="h-5 aspect-auto w-auto" alt="warp.green logo" width={837} height={281} priority />
          <p className="text-sm text-theme-purple">Community front end by aWizard</p>
        </Link>

        <div className="xl:hidden flex justify-end">
          <MobileNav />
        </div>

        <div className="hidden xl:flex justify-center">
          <DesktopNav />
        </div>

        {/* Desktop Menu */}
        <div className="hidden xl:flex gap-2 min-w-[335px] justify-end">
          <EthereumWalletButton />
          <WalletModal />
        </div>
      </header>
    </>
  )
}

export default Header