import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';

const TABS = [
  { href: '/', label: 'Today' },
  { href: '/waters', label: 'Waters' },
  { href: '/trends', label: 'Trends' },
];

export default function Chrome({ title = 'Riffle', children }) {
  const { pathname } = useRouter();
  return (
    <div className="app">
      <Head>
        <title>{title === 'Riffle' ? 'Riffle' : `${title} · Riffle`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#14201e" />
        <link rel="icon" href="/favicon.ico" />
        {/* Added to the home screen, it opens without Safari's chrome —
            the closest a web build gets to feeling like the real app. */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Riffle" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>
      <header className="bar">
        <h1>{title}</h1>
        <nav>
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={pathname === tab.href ? 'on' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
