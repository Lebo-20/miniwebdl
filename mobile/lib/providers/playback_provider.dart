import 'package:flutter/material.dart';
import '../models/drama_model.dart';
import '../services/api_service.dart';
import '../services/firestore_service.dart';

class PlaybackProvider extends ChangeNotifier {
  final ApiService _api = ApiService();
  final FirestoreService _firestore = FirestoreService();

  List<DramaModel> _dramas = [];
  List<dynamic> _platforms = [];
  Map<String, dynamic> _favorites = {};
  Map<String, dynamic> _history = {};
  
  bool _isLoadingCatalog = false;
  bool _isInitialized = false;

  List<DramaModel> get dramas => _dramas;
  List<dynamic> get platforms => _platforms;
  Map<String, dynamic> get favorites => _favorites;
  Map<String, dynamic> get history => _history;
  bool get isLoadingCatalog => _isLoadingCatalog;

  // 1. Initialize and sync Firestore data
  Future<void> initializeData(String userId) async {
    if (_isInitialized) return;
    
    // Initial local read
    _favorites = await _firestore.getLocalFavorites();
    _history = await _firestore.getLocalHistory();
    notifyListeners();

    // Trigger sync in background
    _firestore.syncFavorites(userId).then((_) async {
      _favorites = await _firestore.getLocalFavorites();
      notifyListeners();
    });

    _firestore.syncHistory(userId).then((_) async {
      _history = await _firestore.getLocalHistory();
      notifyListeners();
    });

    // Load API catalog
    await loadApiCatalog();
    _isInitialized = true;
  }

  // 2. Load API Catalog dynamically in the background (incremental platform load)
  Future<void> loadApiCatalog() async {
    _isLoadingCatalog = true;
    notifyListeners();

    try {
      // Fetch platform list
      final rawPlatforms = await _api.getPlatforms();
      _platforms = rawPlatforms;
      _dramas = []; // Clear current list
      notifyListeners();

      // Loop through each platform source and load catalog incrementally in parallel
      for (var source in rawPlatforms) {
        if (source['status'] == 'active') {
          _loadCatalogForPlatform(source);
        }
      }
    } catch (e) {
      print('Error loading catalog: $e');
    } finally {
      _isLoadingCatalog = false;
      notifyListeners();
    }
  }

  // Async task to fetch catalog data for a single platform
  Future<void> _loadCatalogForPlatform(Map<String, dynamic> source) async {
    try {
      final slug = source['slug'] ?? '';
      final platformName = source['platform'] ?? '';
      
      // Select endpoint index for catalog (defaults to 1 or config value)
      final catalogIndex = source['catalogEndpointIndex'] ?? 1;
      final catalogPath = source['catalogPath'] ?? '/api/platform/$slug/endpoint/$catalogIndex';

      final List<dynamic> rawCatalog = await _api.getPlatformCatalog(catalogPath);
      final List<DramaModel> platformDramas = rawCatalog
          .map((item) => DramaModel.fromJson({
                ...item,
                'platform': platformName,
              }))
          .toList();

      if (platformDramas.isNotEmpty) {
        // Merge and remove duplicates
        final merged = [..._dramas, ...platformDramas];
        final uniqueMap = <String, DramaModel>{};
        for (var d in merged) {
          uniqueMap[d.id] = d;
        }
        
        _dramas = uniqueMap.values.toList();
        notifyListeners();
      }
    } catch (e) {
      print('Failed to load incremental catalog for ${source['platform']}: $e');
    }
  }

  // 3. Add/Remove Watchlist (Favorites)
  Future<void> toggleFavorite(String userId, DramaModel drama) async {
    final dramaId = drama.id;
    if (_favorites.containsKey(dramaId)) {
      _favorites.remove(dramaId);
      notifyListeners();
      await _firestore.removeFromFavorites(userId, dramaId);
    } else {
      final dramaData = drama.toJson();
      _favorites[dramaId] = {
        ...dramaData,
        'updatedAt': DateTime.now().toIso8601String(),
      };
      notifyListeners();
      await _firestore.addToFavorites(userId, dramaId, dramaData);
    }
  }

  bool isFavorite(String dramaId) => _favorites.containsKey(dramaId);

  // 4. Update Playback History (Continue Watching)
  Future<void> updateWatchHistory({
    required String userId,
    required DramaModel drama,
    required int episodeNo,
    required String episodeName,
    required double progress, // Range 0.0 to 1.0
  }) async {
    final dramaId = drama.id;
    final historyItem = {
      'dramaId': dramaId,
      'title': drama.title,
      'platform': drama.platform,
      'poster': drama.poster,
      'episodeNo': episodeNo,
      'episodeName': episodeName,
      'progress': progress,
      'updatedAt': DateTime.now().toIso8601String(),
    };

    _history[dramaId] = historyItem;
    notifyListeners();

    await _firestore.addToHistory(userId, dramaId, historyItem);
  }

  // Get continue watching list sorted by last watched time
  List<dynamic> getContinueWatchingList() {
    final list = _history.values.toList();
    list.sort((a, b) {
      final aTime = DateTime.parse(a['updatedAt'] ?? DateTime.now().toIso8601String());
      final bTime = DateTime.parse(b['updatedAt'] ?? DateTime.now().toIso8601String());
      return bTime.compareTo(aTime);
    });
    return list;
  }
}
