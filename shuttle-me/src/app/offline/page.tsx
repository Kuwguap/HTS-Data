"use client";

// Precached by public/sw.js and served for any navigation that fails. Static:
// no data, no hooks that need the network. The retry link works without JS
// (plain navigation) and with JS reloads the page the user actually wanted.
import { Page } from "@/components/layout/Page";
import { Art } from "@/components/ui/Art";

export default function OfflinePage() {
  return (
    <Page noTabs>
      <div className="k-empty" style={{ paddingTop: 96 }}>
        <Art emoji="📡" src={null} size={64} />
        <h1 className="k-title">You’re offline</h1>
        <p className="k-empty-hint" style={{ maxWidth: 300 }}>
          Check your data or Wi-Fi and try again. Your booking is safe on the server.
        </p>
        <a
          href="/app"
          className="k-btn k-btn--big"
          style={{ marginTop: 16, maxWidth: 280 }}
          onClick={(e) => {
            e.preventDefault();
            window.location.reload();
          }}
        >
          🔄 Try again
        </a>
      </div>
    </Page>
  );
}
