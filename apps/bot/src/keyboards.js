export function mainKeyboard(isAdmin, publicUrl) {
  const rows = [
    [webButton("BUKA TEAMDL", publicUrl, "/", "primary")],
    [
      webButton("JUDUL BARU", publicUrl, "/new", "primary"),
      webButton("CARI JUDUL", publicUrl, "/search", "primary")
    ],
    [webButton("ALL PLATFORM", publicUrl, "/platform", "primary")],
    [webButton("BELI VIP", publicUrl, "/vip", "success")]
  ];

  if (isAdmin) {
    rows.push([
      webButton("OPEN TIKET", publicUrl, "/profile?adminTickets=1", "success"),
      { text: "ADMIN PANEL", url: `${publicUrl}/admin`, style: "success" }
    ]);
  }

  return { inline_keyboard: rows };
}

export function vipKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "7 Hari - Rp 7,000", callback_data: "buy_vip_duration:7" }
      ],
      [
        { text: "14 Hari - Rp 14,000", callback_data: "buy_vip_duration:14" }
      ],
      [
        { text: "30 Hari - Rp 30,000", callback_data: "buy_vip_duration:30" }
      ],
      [
        { text: "60 Hari - Rp 60,000", callback_data: "buy_vip_duration:60" }
      ],
      [
        { text: "90 Hari - Rp 90,000", callback_data: "buy_vip_duration:90" }
      ],
      [
        { text: "⬅️ Kembali", callback_data: "main_menu" }
      ]
    ]
  };
}

export function vipPaymentKeyboard(duration) {
  return {
    inline_keyboard: [
      [
        { text: "📥 Upload Bukti QRIS", callback_data: `upload_proof:${duration}` }
      ],
      [
        { text: "⬅️ Kembali", callback_data: "buy_vip" }
      ]
    ]
  };
}

export function adminVipActionKeyboard(userId, duration) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `admin_vip_action:approve:${userId}:${duration}` },
        { text: "❌ Reject", callback_data: `admin_vip_action:reject:${userId}:${duration}` }
      ]
    ]
  };
}

export function backKeyboard(publicUrl) {
  return {
    inline_keyboard: [[webButton("Kembali ke Home", publicUrl, "/", "primary")]]
  };
}

export function webButton(text, publicUrl, path, style) {
  const url = `${publicUrl}${path}`;
  const button = { text };

  if (publicUrl.startsWith("https://")) {
    button.web_app = { url };
  } else {
    button.url = url;
  }

  if (style) {
    button.style = style;
  }

  return button;
}
