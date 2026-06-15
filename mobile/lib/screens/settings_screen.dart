import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../providers/theme_provider.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({Key? key}) : super(key: key);

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  String _selectedLanguage = 'id';
  String _downloadQuality = '720p';
  bool _pushNotificationsEnabled = true;

  @override
  void initState() {
    super.initState();
    _loadPreferences();
  }

  Future<void> _loadPreferences() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _selectedLanguage = prefs.getString('TEAMDL_language') ?? 'id';
      _downloadQuality = prefs.getString('TEAMDL_download_quality') ?? '720p';
      _pushNotificationsEnabled = prefs.getBool('TEAMDL_notifications') ?? true;
    });
  }

  Future<void> _saveLanguage(String lang) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('TEAMDL_language', lang);
    setState(() {
      _selectedLanguage = lang;
    });
  }

  Future<void> _saveDownloadQuality(String quality) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('TEAMDL_download_quality', quality);
    setState(() {
      _downloadQuality = quality;
    });
  }

  Future<void> _saveNotificationSetting(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('TEAMDL_notifications', value);
    setState(() {
      _pushNotificationsEnabled = value;
    });
    // Trigger subscribe/unsubscribe FCM logic here
  }

  // Clear App Image/Video Caches
  Future<void> _clearCache(BuildContext context) async {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF102846),
        title: const Text('Hapus Cache', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: const Text('Apakah Anda yakin ingin menghapus semua gambar dan berkas cache aplikasi?', style: TextStyle(color: Colors.white70)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Batal', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () {
              // Perform clearing cache
              Navigator.pop(context);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Cache berhasil dibersihkan!'), backgroundColor: Colors.green),
              );
            },
            child: const Text('Hapus', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final themeProvider = Provider.of<ThemeProvider>(context);

    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text('Pengaturan', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        children: [
          // 1. TAMPILAN SECTION
          _buildSectionHeader('TAMPILAN'),
          SwitchListTile(
            title: const Text('Dark Mode / Mode Gelap', style: TextStyle(color: Colors.white)),
            subtitle: const Text('Ubah tema visual ke gelap/terang', style: TextStyle(color: Colors.white54, fontSize: 12)),
            value: themeProvider.isDarkMode,
            activeColor: const Color(0xFFFFD700),
            onChanged: (value) {
              themeProvider.toggleTheme(value);
            },
          ),
          const Divider(color: Colors.white10),

          // 2. KONTEN & BAHASA SECTION
          _buildSectionHeader('KONTEN & BAHASA'),
          ListTile(
            title: const Text('Bahasa Aplikasi', style: TextStyle(color: Colors.white)),
            subtitle: Text(_selectedLanguage == 'id' ? 'Bahasa Indonesia' : 'English', style: const TextStyle(color: Colors.white54, fontSize: 12)),
            trailing: const Icon(Icons.chevron_right, color: Colors.white24),
            onTap: () => _showLanguagePicker(),
          ),
          const Divider(color: Colors.white10),

          // 3. UNDUHAN SECTION
          _buildSectionHeader('PENGATURAN UNDUHAN'),
          ListTile(
            title: const Text('Kualitas Unduhan Video', style: TextStyle(color: Colors.white)),
            subtitle: Text('Resolusi saat ini: $_downloadQuality', style: const TextStyle(color: Colors.white54, fontSize: 12)),
            trailing: const Icon(Icons.chevron_right, color: Colors.white24),
            onTap: () => _showQualityPicker(),
          ),
          const Divider(color: Colors.white10),

          // 4. NOTIFIKASI SECTION
          _buildSectionHeader('NOTIFIKASI'),
          SwitchListTile(
            title: const Text('Push Notification', style: TextStyle(color: Colors.white)),
            subtitle: const Text('Dapatkan info episode baru dan promo', style: TextStyle(color: Colors.white54, fontSize: 12)),
            value: _pushNotificationsEnabled,
            activeColor: const Color(0xFFFFD700),
            onChanged: _saveNotificationSetting,
          ),
          const Divider(color: Colors.white10),

          // 5. PENYIMPANAN SECTION
          _buildSectionHeader('PENYIMPANAN & CACHE'),
          ListTile(
            title: const Text('Bersihkan Cache', style: TextStyle(color: Colors.white)),
            subtitle: const Text('Bebaskan ruang memori yang digunakan cache gambar', style: TextStyle(color: Colors.white54, fontSize: 12)),
            trailing: const Icon(Icons.delete_sweep, color: Colors.white70),
            onTap: () => _clearCache(context),
          ),
          const Divider(color: Colors.white10),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12.0, horizontal: 16.0),
      child: Text(
        title,
        style: const TextStyle(
          color: Color(0xFFFFD700),
          fontWeight: FontWeight.bold,
          fontSize: 12,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  void _showLanguagePicker() {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF102846),
      builder: (context) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                title: const Text('Bahasa Indonesia', style: TextStyle(color: Colors.white)),
                trailing: _selectedLanguage == 'id' ? const Icon(Icons.check, color: Color(0xFFFFD700)) : null,
                onTap: () {
                  _saveLanguage('id');
                  Navigator.pop(context);
                },
              ),
              ListTile(
                title: const Text('English', style: TextStyle(color: Colors.white)),
                trailing: _selectedLanguage == 'en' ? const Icon(Icons.check, color: Color(0xFFFFD700)) : null,
                onTap: () {
                  _saveLanguage('en');
                  Navigator.pop(context);
                },
              ),
            ],
          ),
        );
      },
    );
  }

  void _showQualityPicker() {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF102846),
      builder: (context) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: ['1080p (Full HD)', '720p (HD)', '480p (SD)'].map((qualityLabel) {
              final val = qualityLabel.split(' ')[0];
              return ListTile(
                title: Text(qualityLabel, style: const TextStyle(color: Colors.white)),
                trailing: _downloadQuality == val ? const Icon(Icons.check, color: Color(0xFFFFD700)) : null,
                onTap: () {
                  _saveDownloadQuality(val);
                  Navigator.pop(context);
                },
              );
            }).toList(),
          ),
        );
      },
    );
  }
}
