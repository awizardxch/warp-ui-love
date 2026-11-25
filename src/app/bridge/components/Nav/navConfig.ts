import { STATUS_URL, WRAPPED_STOCK_TOKENS } from "../../config"

interface NavConfig {
  name: string
  link: string
  isExternalLink?: boolean
}

export const navConfig: NavConfig[] = [
  {
    name: 'Bridge',
    link: '/bridge'
  },
  {
    name: 'Supported Assets',
    link: '/bridge/assets'
  },
  // Only shown once a wrapped stock is configured
  ...(WRAPPED_STOCK_TOKENS.length > 0 ? [{
    name: 'Wrap Stocks',
    link: '/bridge/wrap'
  }] : []),
  {
    name: 'Docs',
    link: 'https://docs.warp.green/developers/introduction',
    isExternalLink: true
  },
  {
    name: 'FAQ',
    link: 'https://docs.warp.green',
    isExternalLink: true
  },
  {
    name: 'Status',
    link: STATUS_URL,
    isExternalLink: true
  }
]
