import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import '../providers/playback_provider.dart';
import '../providers/auth_provider.dart';
import '../models/drama_model.dart';
import '../services/api_service.dart';

class DramaDetailScreen extends StatefulWidget {
  final String dramaId;

  const DramaDetailScreen({Key? key, required this.dramaId}) : super(key: key);

  @override
  State<DramaDetailScreen> createState() => _DramaDetailScreenState();
}

class _DramaDetailScreenState extends State<DramaDetailScreen> {
  final ApiService _api = ApiService();
  List<dynamic> _episodes = [];
  bool _isLoadingEpisodes = true;
  String? _episodeError;

  @override
  void initState() {
    super.initState();
    _fetchEpisodes();
  }

  Future<void> _fetchEpisodes() async {
    final playback = Provider.of<PlaybackProvider>(context, listen: false);
    final drama = playback.dramas.firstWhere((d) => d.id == widget.dramaId, orElse: () => null as dynamic);
    
    if (drama == null) {
      setState(() {
        _isLoadingEpisodes = false;
        _episodeError = 'Drama tidak ditemukan';
      });
      return;
    }

    try {
      // Find the platform configurations from platform list
      final platformInfo = playback.platforms.firstWhere(
        (p) => p['platform'] == drama.platform,
        orElse: () => null,
      );

      final episodesEndpoint = platformInfo?['episode']?['episodesEndpoint'] ?? 5;
      final idParam = platformInfo?['episode']?['idParam'] ?? 'id';
      
      final String path = '/api/platform/${platformInfo?['slug'] ?? drama.platform.toLowerCase()}/endpoint/$episodesEndpoint?$idParam=${drama.id}';
      
      final rawList = await _api.getPlatformCatalog(path);
      
      setState(() {
        _episodes = rawList;
        _isLoadingEpisodes = false;
      });
    } catch (e) {
      setState(() {
        _isLoadingEpisodes = false;
        _episodeError = 'Gagal memuat daftar episode: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final playback = Provider.of<PlaybackProvider>(context);
    final auth = Provider.of<AuthProvider>(context);
    
    final drama = playback.dramas.firstWhere(
      (d) => d.id == widget.dramaId,
      orElse: () => DramaModel(
        id: widget.dramaId,
        title: 'Memuat...',
        platform: '',
        episodes: 0,
        genre: '',
        country: '',
        year: '',
        vip: false,
        rating: '0.0',
        synopsis: '',
        poster: '',
        backdrop: '',
        tone: 'blue',
      ),
    );

    final isFav = playback.isFavorite(drama.id);
    final user = auth.user;

    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      body: CustomScrollView(
        slivers: [
          // 1. Silver AppBar with backdrop
          SliverAppBar(
            expandedHeight: 250,
            pinned: true,
            backgroundColor: const Color(0xFF071424),
            flexibleSpace: FlexibleSpaceBar(
              background: Stack(
                fit: StackFit.expand,
                children: [
                  CachedNetworkImage(
                    imageUrl: drama.backdrop.isNotEmpty ? drama.backdrop : drama.poster,
                    fit: BoxFit.cover,
                    placeholder: (context, url) => Container(color: const Color(0xFF102846)),
                    errorWidget: (context, url, error) => Container(color: const Color(0xFF102846)),
                  ),
                  Container(
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(
                        colors: [Color(0xFF071424), Colors.transparent],
                        begin: Alignment.bottomCenter,
                        end: Alignment.topCenter,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // 2. Info Detail Box
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Meta Info Row
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFD700),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          drama.platform,
                          style: const TextStyle(
                            color: Color(0xFF071424),
                            fontWeight: FontWeight.bold,
                            fontSize: 10,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text('${drama.episodes} Episode', style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      const SizedBox(width: 8),
                      Text(drama.country, style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      const SizedBox(width: 8),
                      Text(drama.year, style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      const Spacer(),
                      const Icon(Icons.star, color: Color(0xFFFFD700), size: 16),
                      const SizedBox(width: 4),
                      Text(drama.rating, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12)),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // Title
                  Text(
                    drama.title,
                    style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: Colors.white),
                  ),
                  const SizedBox(height: 6),
                  Text(drama.genre, style: const TextStyle(color: Color(0xFFFFD700), fontSize: 13, fontWeight: FontWeight.w500)),
                  const SizedBox(height: 12),
                  // Synopsis
                  Text(
                    drama.synopsis,
                    style: const TextStyle(color: Colors.white70, fontSize: 13, height: 1.4),
                  ),
                  const SizedBox(height: 20),

                  // Actions Row
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: () {
                            if (_episodes.isNotEmpty) {
                              _playEpisode(context, 1);
                            }
                          },
                          icon: const Icon(Icons.play_arrow),
                          label: const Text('WATCH NOW', style: TextStyle(fontWeight: FontWeight.bold)),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFFFD700),
                            foregroundColor: const Color(0xFF071424),
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      OutlinedButton.icon(
                        onPressed: () {
                          if (user != null) {
                            playback.toggleFavorite(user.userId, drama);
                          }
                        },
                        icon: Icon(isFav ? Icons.favorite : Icons.favorite_border, color: Colors.white),
                        label: Text(isFav ? 'Favorit' : 'Tambah', style: const TextStyle(color: Colors.white)),
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
                          side: const BorderSide(color: Colors.white24),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  const Text('Daftar Episode', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.white)),
                  const SizedBox(height: 12),
                ],
              ),
            ),
          ),

          // 3. Episode Grid list
          _isLoadingEpisodes
              ? const SliverToBoxAdapter(
                  child: Center(
                    child: Padding(
                      padding: EdgeInsets.all(40.0),
                      child: SpinKitRing(color: Color(0xFFFFD700), size: 36, lineWidth: 2.5),
                    ),
                  ),
                )
              : _episodeError != null
                  ? SliverToBoxAdapter(
                      child: Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24.0),
                          child: Text(_episodeError!, style: const TextStyle(color: Colors.redAccent)),
                        ),
                      ),
                    )
                  : SliverPadding(
                      padding: const EdgeInsets.symmetric(horizontal: 16.0),
                      sliver: SliverGrid(
                        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 4,
                          crossAxisSpacing: 10,
                          mainAxisSpacing: 10,
                          childAspectRatio: 1.3,
                        ),
                        delegate: SliverChildBuilderDelegate(
                          (context, index) {
                            final epNum = index + 1;
                            final isLocked = epNum > 12 && !(user?.isVip ?? false);
                            
                            return InkWell(
                              onTap: () {
                                if (isLocked) {
                                  _showVipPrompt(context);
                                } else {
                                  _playEpisode(context, epNum);
                                }
                              },
                              child: Container(
                                decoration: BoxDecoration(
                                  color: isLocked ? const Color(0xFF102846).withOpacity(0.4) : const Color(0xFF102846),
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(
                                    color: isLocked ? Colors.redAccent.withOpacity(0.3) : Colors.white10,
                                  ),
                                ),
                                child: Stack(
                                  children: [
                                    Center(
                                      child: Text(
                                        '$epNum',
                                        style: TextStyle(
                                          fontSize: 16,
                                          fontWeight: FontWeight.bold,
                                          color: isLocked ? Colors.white30 : Colors.white,
                                        ),
                                      ),
                                    ),
                                    if (isLocked)
                                      const Positioned(
                                        bottom: 4,
                                        right: 4,
                                        child: Icon(Icons.lock, size: 14, color: Colors.redAccent),
                                      ),
                                  ],
                                ),
                              ),
                            );
                          },
                          childCount: _episodes.isNotEmpty ? _episodes.length : drama.episodes,
                        ),
                      ),
                    ),
          const SliverToBoxAdapter(child: SizedBox(height: 40)),
        ],
      ),
    );
  }

  void _playEpisode(BuildContext context, int epNo) {
    Navigator.pushNamed(context, '/watch', arguments: {
      'dramaId': widget.dramaId,
      'episodeId': '$epNo',
    });
  }

  void _showVipPrompt(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF102846),
        title: const Text('🔒 Konten VIP Premium', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: const Text(
          'Episode 13 ke atas dikunci untuk anggota VIP saja. Silakan buka halaman Profil di bot Telegram @teamdlbot untuk mengaktifkan VIP Premium.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('TUTUP', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              // Focus profile navigation tab
            },
            child: const Text('AKTIFKAN VIP', style: TextStyle(color: Color(0xFFFFD700), fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }
}
