import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../providers/playback_provider.dart';
import '../providers/auth_provider.dart';

class WatchlistScreen extends StatefulWidget {
  const WatchlistScreen({Key? key}) : super(key: key);

  @override
  State<WatchlistScreen> createState() => _WatchlistScreenState();
}

class _WatchlistScreenState extends State<WatchlistScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final playback = Provider.of<PlaybackProvider>(context);
    final auth = Provider.of<AuthProvider>(context);
    
    final favoritesList = playback.favorites.values.toList();
    final historyList = playback.getContinueWatchingList();

    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text('Koleksi Saya', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: const Color(0xFFFFD700),
          labelColor: const Color(0xFFFFD700),
          unselectedLabelColor: Colors.white54,
          tabs: const [
            Tab(text: 'Watchlist'),
            Tab(text: 'Riwayat'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          // 1. Favorites Tab
          _buildFavoritesTab(context, auth.user?.userId ?? '', favoritesList),
          
          // 2. History Tab
          _buildHistoryTab(context, historyList),
        ],
      ),
    );
  }

  Widget _buildFavoritesTab(BuildContext context, String userId, List<dynamic> favorites) {
    if (favorites.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.favorite_border, size: 64, color: Colors.white10),
            SizedBox(height: 12),
            Text('Watchlist Anda kosong.', style: TextStyle(color: Colors.white38)),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: favorites.length,
      itemBuilder: (context, index) {
        final item = favorites[index];
        final dramaId = item['id'];

        return Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            color: const Color(0xFF102846),
            borderRadius: BorderRadius.circular(10),
          ),
          child: ListTile(
            onTap: () {
              Navigator.pushNamed(context, '/detail', arguments: dramaId);
            },
            leading: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: CachedNetworkImage(
                imageUrl: item['poster'] ?? '',
                width: 45,
                height: 65,
                fit: BoxFit.cover,
                placeholder: (context, url) => Container(color: Colors.black12),
                errorWidget: (context, url, error) => Container(color: Colors.black26),
              ),
            ),
            title: Text(
              item['title'] ?? '',
              style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
            ),
            subtitle: Text(
              '${item['platform']} • ${item['genre']}',
              style: const TextStyle(color: Colors.white54, fontSize: 12),
            ),
            trailing: IconButton(
              icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
              onPressed: () {
                final playback = Provider.of<PlaybackProvider>(context, listen: false);
                // We create a mock drama object just to pass ID to toggle favorite
                // Since toggleFavorite uses drama.id to find and remove
                playback.toggleFavorite(userId, playback.dramas.firstWhere((d) => d.id == dramaId));
              },
            ),
          ),
        );
      },
    );
  }

  Widget _buildHistoryTab(BuildContext context, List<dynamic> history) {
    if (history.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.history, size: 64, color: Colors.white10),
            SizedBox(height: 12),
            Text('Belum ada riwayat tontonan.', style: TextStyle(color: Colors.white38)),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: history.length,
      itemBuilder: (context, index) {
        final item = history[index];
        final progress = item['progress'] is double 
            ? item['progress'] 
            : (double.tryParse(item['progress']?.toString() ?? '0.0') ?? 0.0);

        return Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            color: const Color(0xFF102846),
            borderRadius: BorderRadius.circular(10),
          ),
          child: ListTile(
            onTap: () {
              Navigator.pushNamed(context, '/watch', arguments: {
                'dramaId': item['dramaId'],
                'episodeId': item['episodeNo']?.toString() ?? '1',
              });
            },
            leading: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: CachedNetworkImage(
                imageUrl: item['poster'] ?? '',
                width: 45,
                height: 65,
                fit: BoxFit.cover,
                placeholder: (context, url) => Container(color: Colors.black12),
                errorWidget: (context, url, error) => Container(color: Colors.black26),
              ),
            ),
            title: Text(
              item['title'] ?? '',
              style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
            ),
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 2),
                Text(
                  'Episode ${item['episodeNo']}: ${item['episodeName']}',
                  style: const TextStyle(color: Colors.white70, fontSize: 11),
                ),
                const SizedBox(height: 6),
                LinearProgressIndicator(
                  value: progress,
                  backgroundColor: Colors.white10,
                  valueColor: const AlwaysStoppedAnimation<Color>(Color(0xFFFFD700)),
                  minHeight: 2,
                )
              ],
            ),
            trailing: const Icon(Icons.play_arrow_outlined, color: Color(0xFFFFD700)),
          ),
        );
      },
    );
  }
}
