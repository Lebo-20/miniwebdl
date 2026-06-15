import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/auth_provider.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final auth = Provider.of<AuthProvider>(context);
    final user = auth.user;

    if (user == null) {
      return const Scaffold(
        backgroundColor: const Color(0xFF071424),
        body: Center(child: Text('Data pengguna tidak ditemukan.', style: TextStyle(color: Colors.white))),
      );
    }

    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text('Profil Saya', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.settings, color: Colors.white),
            onPressed: () {
              Navigator.pushNamed(context, '/settings');
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          await auth.refreshProfile();
        },
        color: const Color(0xFFFFD700),
        backgroundColor: const Color(0xFF102846),
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.symmetric(horizontal: 20.0, vertical: 16.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 1. Profile header card
              _buildProfileHeader(user),
              const SizedBox(height: 24),

              // 2. Membership status card
              _buildMembershipCard(context, user),
              const SizedBox(height: 24),

              // 3. Admin Panel button (only if admin!)
              if (user.isAdmin) ...[
                _buildAdminPanelButton(context),
                const SizedBox(height: 24),
              ],

              // 4. Options and settings quick links
              _buildQuickLinks(context),
              const SizedBox(height: 36),

              // 5. Logout Button
              OutlinedButton.icon(
                onPressed: () {
                  _showLogoutDialog(context, auth);
                },
                icon: const Icon(Icons.logout, color: Colors.redAccent),
                label: const Text('LOGOUT / KELUAR', style: TextStyle(color: Colors.redAccent, fontWeight: FontWeight.bold)),
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  side: const BorderSide(color: Colors.redAccent),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
              const SizedBox(height: 40),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildProfileHeader(dynamic user) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: const Color(0xFF102846),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          // Avatar (Telegram style)
          CircleAvatar(
            radius: 36,
            backgroundColor: const Color(0xFFFFD700),
            child: Text(
              user.firstName.isNotEmpty ? user.firstName[0].toUpperCase() : 'U',
              style: const TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.bold,
                color: Color(0xFF071424),
              ),
            ),
          ),
          const SizedBox(width: 20),
          // User Metadata
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  user.displayName,
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  user.username.isNotEmpty ? '@${user.username}' : '-',
                  style: const TextStyle(
                    fontSize: 14,
                    color: Colors.white54,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'ID: tg-${user.telegramId}',
                  style: const TextStyle(
                    fontSize: 12,
                    color: Colors.white38,
                    fontFamily: 'Courier',
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMembershipCard(BuildContext context, dynamic user) {
    final bool isVip = user.isVip;
    
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: isVip
              ? [const Color(0xFFFFD700).withOpacity(0.15), const Color(0xFFFFA500).withOpacity(0.05)]
              : [const Color(0xFF102846), const Color(0xFF102846).withOpacity(0.8)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isVip ? const Color(0xFFFFD700).withOpacity(0.3) : Colors.white10,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                isVip ? '👑 VIP PREMIUM' : '💎 MEMBER REGULER',
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  color: isVip ? const Color(0xFFFFD700) : Colors.white70,
                  fontSize: 16,
                  letterSpacing: 1.0,
                ),
              ),
              if (isVip)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFD700),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Text(
                    'AKTIF',
                    style: TextStyle(
                      color: Color(0xFF071424),
                      fontWeight: FontWeight.bold,
                      fontSize: 10,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          if (isVip) ...[
            Text(
              user.vipExpiresAt != null
                  ? 'Masa berlaku sampai: ${user.vipExpiresAt!.day}/${user.vipExpiresAt!.month}/${user.vipExpiresAt!.year}'
                  : 'Akses VIP Aktif Selamanya',
              style: const TextStyle(color: Colors.white70, fontSize: 13),
            ),
            const SizedBox(height: 6),
            const Text(
              'Anda bebas menonton semua episode 13+ di semua drama!',
              style: TextStyle(color: Colors.white54, fontSize: 11),
            ),
          ] else ...[
            const Text(
              'Akses VIP Terbatas (Hanya Episode 1-12)',
              style: TextStyle(color: Colors.white70, fontSize: 13),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: () {
                _showVipInstructions(context);
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFFFFD700),
                foregroundColor: const Color(0xFF071424),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              ),
              child: const Text('AKTIFKAN VIP PREMIUM', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildAdminPanelButton(BuildContext context) {
    return InkWell(
      onTap: () {
        Navigator.pushNamed(context, '/admin');
      },
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: Colors.redAccent.withOpacity(0.1),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.redAccent.withOpacity(0.3)),
        ),
        child: const Row(
          children: [
            Icon(Icons.admin_panel_settings, color: Colors.redAccent, size: 28),
            SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'PANEL ADMINISTRATOR',
                    style: TextStyle(fontWeight: FontWeight.bold, color: Colors.redAccent, fontSize: 14),
                  ),
                  SizedBox(height: 2),
                  Text(
                    'Kelola user, konten, siaran, dan monitor error.',
                    style: TextStyle(color: Colors.white54, fontSize: 11),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: Colors.redAccent),
          ],
        ),
      ),
    );
  }

  Widget _buildQuickLinks(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF102846),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        children: [
          ListTile(
            leading: const Icon(Icons.download, color: Colors.white70),
            title: const Text('Hasil Unduhan Offline', style: TextStyle(color: Colors.white)),
            trailing: const Icon(Icons.chevron_right, color: Colors.white24),
            onTap: () {
              Navigator.pushNamed(context, '/downloads');
            },
          ),
          const Divider(color: Colors.white10, height: 1),
          ListTile(
            leading: const Icon(Icons.help_outline, color: Colors.white70),
            title: const Text('Pusat Bantuan & Live Chat', style: TextStyle(color: Colors.white)),
            trailing: const Icon(Icons.chevron_right, color: Colors.white24),
            onTap: () {
              Navigator.pushNamed(context, '/help');
            },
          ),
        ],
      ),
    );
  }

  void _showVipInstructions(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF102846),
        title: const Text('Aktivasi VIP Premium', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: const Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Untuk melakukan aktivasi status VIP:', style: TextStyle(color: Colors.white)),
            SizedBox(height: 12),
            Text('1. Buka Bot Telegram kami: @teamdlbot', style: TextStyle(color: Colors.white70)),
            SizedBox(height: 6),
            Text('2. Pilih menu "BELI VIP" atau ketik perintah /vip', style: TextStyle(color: Colors.white70)),
            SizedBox(height: 6),
            Text('3. Lakukan pembayaran via QRIS dan upload bukti pembayaran langsung di chat bot.', style: TextStyle(color: Colors.white70)),
            SizedBox(height: 6),
            Text('4. Admin akan memproses aktivasi Anda maksimal dalam 24 jam.', style: TextStyle(color: Colors.white70)),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK', style: TextStyle(color: Color(0xFFFFD700))),
          )
        ],
      ),
    );
  }

  void _showLogoutDialog(BuildContext context, AuthProvider auth) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF102846),
        title: const Text('Konfirmasi Logout', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: const Text('Apakah Anda yakin ingin keluar dari aplikasi?', style: TextStyle(color: Colors.white70)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Batal', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(context); // Close dialog
              await auth.logout();
              Navigator.pushReplacementNamed(context, '/login');
            },
            child: const Text('Keluar', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
  }
}
