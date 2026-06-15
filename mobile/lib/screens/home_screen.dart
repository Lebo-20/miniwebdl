import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import '../providers/auth_provider.dart';
import '../providers/playback_provider.dart';
import '../models/drama_model.dart';
import 'search_screen.dart';
import 'watchlist_screen.dart';
import 'profile_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({Key? key}) : super(key: key);

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _currentIndex = 0;

  late List<Widget> _tabs;

  @override
  void initState() {
    super.initState();
    _tabs = [
      const HomeTab(),
      const SearchScreen(),
      const WatchlistScreen(),
      const ProfileScreen(),
    ];
    
    // Fetch profile and sync data on startup
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final auth = Provider.of<AuthProvider>(context, listen: false);
      if (auth.isAuthenticated) {
        Provider.of<PlaybackProvider>(context, listen: false).initializeData(auth.user!.userId);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      body: IndexedStack(
        index: _currentIndex,
        children: _tabs,
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentIndex,
        onTap: (index) {
          setState(() {
            _currentIndex = index;
          });
        },
        type: BottomNavigationBarType.fixed,
        backgroundColor: const Color(0xFF102846),
        selectedItemColor: const Color(0xFFFFD700),
        unselectedItemColor: Colors.white54,
        showUnselectedLabels: true,
        selectedFontSize: 12,
        unselectedFontSize: 11,
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.home_filled),
            label: 'Home',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.search),
            label: 'Cari',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.favorite),
            label: 'Watchlist',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.person),
            label: 'Profil',
          ),
        ],
      ),
    );
  }
}

// ==========================================
// HOME TAB CONTENT
// ==========================================
class HomeTab extends StatelessWidget {
  const HomeTab({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final playback = Provider.of<PlaybackProvider>(context);
    final continueWatching = playback.getContinueWatchingList();
    
    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text(
          'TEAMDL',
          style: TextStyle(
            color: Color(0xFFFFD700),
            fontWeight: FontWeight.bold,
            letterSpacing: 2,
          ),
        ),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.notifications_none, color: Colors.white),
            onPressed: () {},
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          await playback.loadApiCatalog();
        },
        color: const Color(0xFFFFD700),
        backgroundColor: const Color(0xFF102846),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 1. Banner Slider
              if (playback.dramas.isNotEmpty)
                _buildHeroBanner(context, playback.dramas.first)
              else
                _buildBannerPlaceholder(),
              
              const SizedBox(height: 24),

              // 2. Active Platforms Horizontal List
              _buildSectionTitle('Platform Rekanan'),
              _buildPlatformScroller(playback),

              // 3. Continue Watching (if exists)
              if (continueWatching.isNotEmpty) ...[
                const SizedBox(height: 24),
                _buildSectionTitle('Lanjutkan Menonton'),
                _buildContinueWatchingRail(context, continueWatching),
              ],

              // 4. New Contents Grid
              const SizedBox(height: 24),
              _buildSectionTitle('Drama Terbaru'),
              playback.isLoadingCatalog && playback.dramas.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(36.0),
                        child: SpinKitRing(
                          color: Color(0xFFFFD700),
                          size: 36,
                          lineWidth: 2.5,
                        ),
                      ),
                    )
                  : _buildDramaGrid(context, playback.dramas),
                  
              const SizedBox(height: 40),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
      child: Text(
        title,
        style: const TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.bold,
          color: Colors.white,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  // BANNERS WIDGET
  Widget _buildHeroBanner(BuildContext context, DramaModel drama) {
    return GestureDetector(
      onTap: () {
        Navigator.pushNamed(context, '/detail', arguments: drama.id);
      },
      child: Container(
        height: 220,
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          boxShadow: const [
            BoxShadow(
              color: Colors.black38,
              blurRadius: 10,
              offset: Offset(0, 4),
            )
          ]
        ),
        child: Stack(
          children: [
            // Poster/Backdrop Image
            ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: CachedNetworkImage(
                imageUrl: drama.poster.isNotEmpty ? drama.poster : 'https://placehold.co/600x300/102846/FFF?text=${Uri.encodeComponent(drama.title)}',
                fit: BoxFit.cover,
                width: double.infinity,
                height: double.infinity,
                placeholder: (context, url) => Container(color: const Color(0xFF102846)),
                errorWidget: (context, url, error) => Container(
                  color: const Color(0xFF102846),
                  child: Center(
                    child: Text(
                      drama.title,
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
              ),
            ),
            // Gradient Overlay
            Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                gradient: LinearGradient(
                  colors: [Colors.black.withOpacity(0.8), Colors.transparent],
                  begin: Alignment.bottomCenter,
                  end: Alignment.topCenter,
                ),
              ),
            ),
            // Text Details
            Positioned(
              bottom: 16,
              left: 16,
              right: 16,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFD700),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          drama.platform,
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF071424),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '${drama.episodes} Episode',
                        style: const TextStyle(color: Colors.white70, fontSize: 12),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    drama.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBannerPlaceholder() {
    return Container(
      height: 200,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF102846),
        borderRadius: BorderRadius.circular(16),
      ),
      child: const Center(
        child: SpinKitRing(
          color: Color(0xFFFFD700),
          size: 30,
          lineWidth: 2,
        ),
      ),
    );
  }

  // PLATFORM FILTER WIDGET
  Widget _buildPlatformScroller(PlaybackProvider playback) {
    return SizedBox(
      height: 48,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(horizontal: 12.0),
        scrollDirection: Axis.horizontal,
        itemCount: playback.platforms.length,
        itemBuilder: (context, index) {
          final platform = playback.platforms[index];
          final isActive = platform['status'] == 'active';
          
          return Container(
            margin: const EdgeInsets.symmetric(horizontal: 6.0, vertical: 4.0),
            child: FilterChip(
              label: Text(
                platform['platform'] ?? '',
                style: TextStyle(
                  color: isActive ? const Color(0xFF071424) : Colors.white70,
                  fontWeight: FontWeight.bold,
                  fontSize: 12,
                ),
              ),
              selected: isActive,
              selectedColor: const Color(0xFFFFD700),
              backgroundColor: const Color(0xFF102846),
              onSelected: (_) {},
            ),
          );
        },
      ),
    );
  }

  // CONTINUE WATCHING WIDGET
  Widget _buildContinueWatchingRail(BuildContext context, List<dynamic> list) {
    return SizedBox(
      height: 140,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(horizontal: 12.0),
        scrollDirection: Axis.horizontal,
        itemCount: list.length,
        itemBuilder: (context, index) {
          final item = list[index];
          final progress = item['progress'] is double 
              ? item['progress'] 
              : (double.tryParse(item['progress']?.toString() ?? '0.0') ?? 0.0);
              
          return GestureDetector(
            onTap: () {
              Navigator.pushNamed(context, '/watch', arguments: {
                'dramaId': item['dramaId'],
                'episodeId': item['episodeNo']?.toString() ?? '1',
              });
            },
            child: Container(
              width: 180,
              margin: const EdgeInsets.symmetric(horizontal: 6.0),
              decoration: BoxDecoration(
                color: const Color(0xFF102846),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    child: Stack(
                      children: [
                        ClipRRect(
                          borderRadius: const BorderRadius.vertical(top: Radius.circular(10)),
                          child: CachedNetworkImage(
                            imageUrl: item['poster'] ?? '',
                            fit: BoxFit.cover,
                            width: double.infinity,
                            height: double.infinity,
                            placeholder: (context, url) => Container(color: Colors.black12),
                            errorWidget: (context, url, error) => Container(color: Colors.black26),
                          ),
                        ),
                        // Indicator Play Icon
                        const Center(
                          child: CircleAvatar(
                            backgroundColor: Colors.black45,
                            radius: 18,
                            child: Icon(Icons.play_arrow, color: Colors.white, size: 20),
                          ),
                        ),
                        // Linear Progress Bar
                        Positioned(
                          bottom: 0,
                          left: 0,
                          right: 0,
                          child: LinearProgressIndicator(
                            value: progress,
                            backgroundColor: Colors.white24,
                            valueColor: const AlwaysStoppedAnimation<Color>(Color(0xFFFFD700)),
                            minHeight: 3,
                          ),
                        )
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.all(8.0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          item['title'] ?? '',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Episode ${item['episodeNo']}: ${item['episodeName']}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 10, color: Colors.white54),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  // DRAMA LIST GRID WIDGET
  Widget _buildDramaGrid(BuildContext context, List<DramaModel> list) {
    if (list.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(40.0),
        child: Center(
          child: Text(
            'Tidak ada drama tersedia.',
            style: TextStyle(color: Colors.white54),
          ),
        ),
      );
    }

    return GridView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 16.0),
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        crossAxisSpacing: 10,
        mainAxisSpacing: 16,
        childAspectRatio: 0.65,
      ),
      itemCount: list.length,
      itemBuilder: (context, index) {
        final drama = list[index];
        return GestureDetector(
          onTap: () {
            Navigator.pushNamed(context, '/detail', arguments: drama.id);
          },
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: const [
                      BoxShadow(
                        color: Colors.black26,
                        blurRadius: 4,
                        offset: Offset(0, 2),
                      )
                    ]
                  ),
                  child: Stack(
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: CachedNetworkImage(
                          imageUrl: drama.poster,
                          fit: BoxFit.cover,
                          width: double.infinity,
                          height: double.infinity,
                          placeholder: (context, url) => Container(color: const Color(0xFF102846)),
                          errorWidget: (context, url, error) => Container(
                            color: const Color(0xFF102846),
                            child: Center(
                              child: Text(
                                drama.title,
                                textAlign: TextAlign.center,
                                style: const TextStyle(fontSize: 11, color: Colors.white70),
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (drama.vip)
                        Positioned(
                          top: 6,
                          right: 6,
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFFD700),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: const Text(
                              'VIP',
                              style: TextStyle(
                                fontSize: 9,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF071424),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                drama.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: Colors.white,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                drama.platform,
                style: const TextStyle(fontSize: 10, color: Colors.white54),
              ),
            ],
          ),
        );
      },
    );
  }
}
