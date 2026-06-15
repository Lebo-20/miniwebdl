import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import '../services/api_service.dart';

class AdminDashboard extends StatefulWidget {
  const AdminDashboard({Key? key}) : super(key: key);

  @override
  State<AdminDashboard> createState() => _AdminDashboardState();
}

class _AdminDashboardState extends State<AdminDashboard> with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text('Panel Admin Mobile', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: Colors.redAccent,
          labelColor: Colors.redAccent,
          unselectedLabelColor: Colors.white54,
          isScrollable: true,
          tabs: const [
            Tab(text: 'Statistik'),
            Tab(text: 'Moderasi User'),
            Tab(text: 'Broadcast'),
            Tab(text: 'Stream Monitor'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          const AdminStatsTab(),
          const AdminUserModerationTab(),
          const AdminBroadcastTab(),
          const AdminStreamMonitorTab(),
        ],
      ),
    );
  }
}

// ==========================================
// 1. STATS TAB
// ==========================================
class AdminStatsTab extends StatefulWidget {
  const AdminStatsTab({Key? key}) : super(key: key);

  @override
  State<AdminStatsTab> createState() => _AdminStatsTabState();
}

class _AdminStatsTabState extends State<AdminStatsTab> {
  final ApiService _api = ApiService();
  Map<String, dynamic> _stats = {};
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _fetchStats();
  }

  Future<void> _fetchStats() async {
    try {
      final data = await _api.getAdminVipStats();
      setState(() {
        _stats = data;
        _isLoading = false;
      });
    } catch (e) {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Center(child: SpinKitRing(color: Colors.redAccent, size: 36, lineWidth: 2.5));
    }

    final vipUsers = _stats['vipUsers'] as Map<String, dynamic>? ?? {};
    final totalVip = vipUsers.length;

    return RefreshIndicator(
      onRefresh: _fetchStats,
      color: Colors.redAccent,
      backgroundColor: const Color(0xFF102846),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _buildStatCard('Total User VIP', '$totalVip', Icons.stars, Colors.amber),
          const SizedBox(height: 16),
          _buildStatCard('Status Database', 'Firestore Connected', Icons.cloud_done, Colors.green),
          const SizedBox(height: 16),
          _buildStatCard('Domain Utama', 'teamdlbot.biz.id', Icons.language, Colors.blue),
          const SizedBox(height: 24),
          const Text(
            'LOG TRANSAKSI TERAKHIR',
            style: TextStyle(color: Colors.white38, fontWeight: FontWeight.bold, fontSize: 12),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: const Color(0xFF102846),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Center(
              child: Text('Tidak ada transaksi VIP baru.', style: TextStyle(color: Colors.white54, fontSize: 13)),
            ),
          )
        ],
      ),
    );
  }

  Widget _buildStatCard(String title, String value, IconData icon, Color color) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: const Color(0xFF102846),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: color.withOpacity(0.1),
            child: Icon(icon, color: color),
          ),
          const SizedBox(width: 16),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(color: Colors.white54, fontSize: 13)),
              const SizedBox(height: 4),
              Text(value, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 20)),
            ],
          )
        ],
      ),
    );
  }
}

// ==========================================
// 2. USER MODERATION TAB
// ==========================================
class AdminUserModerationTab extends StatefulWidget {
  const AdminUserModerationTab({Key? key}) : super(key: key);

  @override
  State<AdminUserModerationTab> createState() => _AdminUserModerationTabState();
}

class _AdminUserModerationTabState extends State<AdminUserModerationTab> {
  final ApiService _api = ApiService();
  List<dynamic> _users = [];
  List<dynamic> _filteredUsers = [];
  bool _isLoading = true;
  String _searchQuery = '';

  @override
  void initState() {
    super.initState();
    _fetchUsers();
  }

  Future<void> _fetchUsers() async {
    try {
      final data = await _api.getAdminBotUsers();
      setState(() {
        _users = data;
        _filteredUsers = data;
        _isLoading = false;
      });
    } catch (e) {
      setState(() => _isLoading = false);
    }
  }

  void _filterUsers(String query) {
    setState(() {
      _searchQuery = query;
      _filteredUsers = _users.where((user) {
        final name = '${user['firstName'] ?? ''} ${user['lastName'] ?? ''}'.toLowerCase();
        final username = (user['username'] ?? '').toLowerCase();
        final id = (user['telegramId'] ?? '').toString();
        return name.contains(query.toLowerCase()) ||
            username.contains(query.toLowerCase()) ||
            id.contains(query);
      }).toList();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Search bar
        Padding(
          padding: const EdgeInsets.all(16.0),
          child: TextField(
            onChanged: _filterUsers,
            style: const TextStyle(color: Colors.white),
            decoration: InputDecoration(
              hintText: 'Cari user berdasarkan nama/username/ID...',
              hintStyle: const TextStyle(color: Colors.white38),
              prefixIcon: const Icon(Icons.search, color: Colors.white54),
              filled: true,
              fillColor: const Color(0xFF102846),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),

        // List
        Expanded(
          child: _isLoading
              ? const Center(child: SpinKitRing(color: Colors.redAccent, size: 36, lineWidth: 2.5))
              : _filteredUsers.isEmpty
                  ? const Center(child: Text('User tidak ditemukan.', style: TextStyle(color: Colors.white54)))
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      itemCount: _filteredUsers.length,
                      itemBuilder: (context, index) {
                        final user = _filteredUsers[index];
                        final name = '${user['firstName'] ?? ''} ${user['lastName'] ?? ''}'.trim();
                        final username = user['username'] != null && user['username'].isNotEmpty
                            ? '@${user['username']}'
                            : '-';
                        final tgId = user['telegramId']?.toString() ?? '';
                        final status = user['status'] ?? 'active';
                        final isBanned = status == 'banned';

                        return Container(
                          margin: const EdgeInsets.only(bottom: 12),
                          decoration: BoxDecoration(
                            color: const Color(0xFF102846),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: ListTile(
                            title: Text(name.isNotEmpty ? name : 'tg-$tgId', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                            subtitle: Text('$username • ID: $tgId\nStatus: ${status.toUpperCase()}', style: const TextStyle(color: Colors.white54, fontSize: 11)),
                            isThreeLine: true,
                            trailing: PopupMenuButton<String>(
                              dropdownColor: const Color(0xFF102846),
                              style: const TextStyle(color: Colors.white),
                              onSelected: (action) => _handleAction(tgId, action),
                              itemBuilder: (context) => [
                                PopupMenuItem(
                                  value: isBanned ? 'active' : 'ban',
                                  child: Text(isBanned ? '✅ Unban User' : '🚫 Ban User', style: TextStyle(color: isBanned ? Colors.green : Colors.redAccent)),
                                ),
                                const PopupMenuItem(
                                  value: 'add_vip',
                                  child: Text('👑 Tambah VIP 30 Hari', style: TextStyle(color: Colors.amber)),
                                ),
                                const PopupMenuItem(
                                  value: 'remove_vip',
                                  child: Text('❌ Hapus VIP', style: TextStyle(color: Colors.white70)),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
        ),
      ],
    );
  }

  void _handleAction(String tgId, String action) async {
    setState(() => _isLoading = true);
    try {
      if (action == 'ban' || action == 'active') {
        await _api.performAdminUserAction('tg-$tgId', action, reason: 'Aksi panel admin mobile.');
      } else if (action == 'add_vip') {
        await _api.modifyUserVip('tg-$tgId', 30, 'add');
      } else if (action == 'remove_vip') {
        await _api.modifyUserVip('tg-$tgId', 0, 'remove');
      }
      
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Aksi admin berhasil dijalankan.'), backgroundColor: Colors.green),
      );
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Aksi gagal: $e'), backgroundColor: Colors.redAccent),
      );
    } finally {
      _fetchUsers();
    }
  }
}

// ==========================================
// 3. BROADCAST TAB
// ==========================================
class AdminBroadcastTab extends StatefulWidget {
  const AdminBroadcastTab({Key? key}) : super(key: key);

  @override
  State<AdminBroadcastTab> createState() => _AdminBroadcastTabState();
}

class _AdminBroadcastTabState extends State<AdminBroadcastTab> {
  final ApiService _api = ApiService();
  final _formKey = GlobalKey<FormState>();
  final TextEditingController _titleController = TextEditingController();
  final TextEditingController _msgController = TextEditingController();
  bool _isSending = false;

  void _sendBroadcast() async {
    if (!_formKey.currentState!.validate()) return;
    
    setState(() => _isSending = true);
    
    try {
      await _api.sendAdminBroadcast(
        title: _titleController.text.trim(),
        message: _msgController.text.trim(),
      );
      
      _titleController.clear();
      _msgController.clear();
      
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Broadcast darurat berhasil dikirim!'), backgroundColor: Colors.green),
      );
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Broadcast gagal: $e'), backgroundColor: Colors.redAccent),
      );
    } finally {
      setState(() => _isSending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'SIARAN PESAN DARURAT (PUSH NOTIFICATION)',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
          ),
          const SizedBox(height: 6),
          const Text(
            'Kirimkan push notification ke seluruh pengguna terdaftar secara langsung.',
            style: TextStyle(color: Colors.white54, fontSize: 12),
          ),
          const SizedBox(height: 24),
          
          // Title Input
          TextFormField(
            controller: _titleController,
            style: const TextStyle(color: Colors.white),
            decoration: InputDecoration(
              labelText: 'Judul Siaran',
              labelStyle: const TextStyle(color: Colors.white54),
              filled: true,
              fillColor: const Color(0xFF102846),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
            ),
            validator: (val) => val == null || val.trim().isEmpty ? 'Judul wajib diisi' : null,
          ),
          const SizedBox(height: 16),

          // Message Input
          TextFormField(
            controller: _msgController,
            maxLines: 4,
            style: const TextStyle(color: Colors.white),
            decoration: InputDecoration(
              labelText: 'Isi Pesan Siaran',
              labelStyle: const TextStyle(color: Colors.white54),
              filled: true,
              fillColor: const Color(0xFF102846),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
            ),
            validator: (val) => val == null || val.trim().isEmpty ? 'Pesan wajib diisi' : null,
          ),
          const SizedBox(height: 24),

          _isSending
              ? const Center(child: SpinKitRing(color: Colors.redAccent, size: 36, lineWidth: 2.5))
              : ElevatedButton.icon(
                  onPressed: _sendBroadcast,
                  icon: const Icon(Icons.send),
                  label: const Text('KIRIM BROADCAST SEKARANG', style: TextStyle(fontWeight: FontWeight.bold)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.redAccent,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                ),
        ],
      ),
    );
  }
}

// ==========================================
// 4. STREAM MONITOR TAB
// ==========================================
class AdminStreamMonitorTab extends StatefulWidget {
  const AdminStreamMonitorTab({Key? key}) : super(key: key);

  @override
  State<AdminStreamMonitorTab> createState() => _AdminStreamMonitorTabState();
}

class _AdminStreamMonitorTabState extends State<AdminStreamMonitorTab> {
  final ApiService _api = ApiService();
  List<dynamic> _logs = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _fetchLogs();
  }

  Future<void> _fetchLogs() async {
    try {
      final data = await _api.getAdminStreamLogs();
      setState(() {
        _logs = data;
        _isLoading = false;
      });
    } catch (e) {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _clearLogs() async {
    setState(() => _isLoading = true);
    await _api.clearAdminStreamLogs();
    await _fetchLogs();
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Center(child: SpinKitRing(color: Colors.redAccent, size: 36, lineWidth: 2.5));
    }

    return RefreshIndicator(
      onRefresh: _fetchLogs,
      color: Colors.redAccent,
      backgroundColor: const Color(0xFF102846),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.between,
              children: [
                const Text('LOG ERROR REALTIME', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                TextButton.icon(
                  onPressed: _clearLogs,
                  icon: const Icon(Icons.delete_sweep, color: Colors.redAccent),
                  label: const Text('Bersihkan', style: TextStyle(color: Colors.redAccent)),
                ),
              ],
            ),
          ),
          Expanded(
            child: _logs.isEmpty
                ? const Center(child: Text('Belum ada log error streaming.', style: TextStyle(color: Colors.white54)))
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemCount: _logs.length,
                    itemBuilder: (context, index) {
                      final log = _logs[index];
                      final isError = log['status'] == 'Error';
                      final type = log['errorType'] ?? 'PLAYBACK_FAIL';
                      final time = log['timestamp']?.toString().split('T').join(' ').substring(0, 19) ?? '';

                      return Container(
                        margin: const EdgeInsets.only(bottom: 12),
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFF102846),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: isError ? Colors.redAccent.withOpacity(0.2) : Colors.green.withOpacity(0.2)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.between,
                              children: [
                                Text(
                                  type.toUpperCase(),
                                  style: TextStyle(fontWeight: FontWeight.bold, color: isError ? Colors.redAccent : Colors.green, fontSize: 13),
                                ),
                                Text(time, style: const TextStyle(color: Colors.white38, fontSize: 10)),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text('Drama: ${log['dramaTitle'] ?? '-'} • ${log['episodeName'] ?? '-'}', style: const TextStyle(color: Colors.white, fontSize: 12)),
                            const SizedBox(height: 2),
                            Text('CDN/Platform: ${log['cdn'] ?? '-'}', style: const TextStyle(color: Colors.white70, fontSize: 11)),
                            if (log['details'] != null && log['details'].isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text('Detail: ${log['details']}', style: const TextStyle(color: Colors.white30, fontSize: 10)),
                            ],
                          ],
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
