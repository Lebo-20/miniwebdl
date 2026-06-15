import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';

class DownloadItem {
  final String id;
  final String dramaId;
  final String dramaTitle;
  final int episodeNo;
  final String episodeTitle;
  final String localPath;
  final int sizeInBytes;

  DownloadItem({
    required this.id,
    required this.dramaId,
    required this.dramaTitle,
    required this.episodeNo,
    required this.episodeTitle,
    required this.localPath,
    required this.sizeInBytes,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'dramaId': dramaId,
        'dramaTitle': dramaTitle,
        'episodeNo': episodeNo,
        'episodeTitle': episodeTitle,
        'localPath': localPath,
        'sizeInBytes': sizeInBytes,
      };

  factory DownloadItem.fromJson(Map<String, dynamic> json) => DownloadItem(
        id: json['id'] ?? '',
        dramaId: json['dramaId'] ?? '',
        dramaTitle: json['dramaTitle'] ?? '',
        episodeNo: json['episodeNo'] ?? 0,
        episodeTitle: json['episodeTitle'] ?? '',
        localPath: json['localPath'] ?? '',
        sizeInBytes: json['sizeInBytes'] ?? 0,
      );
}

class DownloadProvider extends ChangeNotifier {
  static const String _keyDownloads = 'TEAMDL_completed_downloads';

  final Dio _dio = Dio();
  final List<DownloadItem> _completedDownloads = [];
  final Map<String, double> _downloadProgress = {}; // progress: 0.0 to 1.0
  final Set<String> _cancelTokens = {}; // list of active download tokens to cancel

  List<DownloadItem> get completedDownloads => _completedDownloads;
  Map<String, double> get downloadProgress => _downloadProgress;

  DownloadProvider() {
    _loadDownloads();
  }

  // Load completed downloads from local storage
  Future<void> _loadDownloads() async {
    final prefs = await SharedPreferences.getInstance();
    final jsonStr = prefs.getString(_keyDownloads) ?? '[]';
    final List<dynamic> list = json.decode(jsonStr);
    
    _completedDownloads.clear();
    for (var item in list) {
      _completedDownloads.add(DownloadItem.fromJson(item));
    }
    notifyListeners();
  }

  // Save completed downloads to local storage
  Future<void> _saveDownloads() async {
    final prefs = await SharedPreferences.getInstance();
    final jsonStr = json.encode(_completedDownloads.map((d) => d.toJson()).toList());
    await prefs.setString(_keyDownloads, jsonStr);
  }

  // Start downloading an episode
  Future<void> startDownload({
    required String episodeId,
    required String dramaId,
    required String dramaTitle,
    required int episodeNo,
    required String episodeTitle,
    required String videoUrl,
  }) async {
    if (_downloadProgress.containsKey(episodeId) || isDownloaded(episodeId)) {
      return; // Already downloading or downloaded
    }

    _downloadProgress[episodeId] = 0.0;
    notifyListeners();

    try {
      final appDir = await getApplicationDocumentsDirectory();
      final folder = Directory('${appDir.path}/downloads/$dramaId');
      if (!await folder.exists()) {
        await folder.create(recursive: true);
      }

      final localPath = '${folder.path}/ep_$episodeNo.mp4';
      final cancelToken = CancelToken();
      _cancelTokens.add(episodeId);

      // Download file using Dio
      await _dio.download(
        videoUrl,
        localPath,
        cancelToken: cancelToken,
        onReceiveProgress: (received, total) {
          if (total != -1) {
            _downloadProgress[episodeId] = received / total;
            notifyListeners();
          }
        },
      );

      final file = File(localPath);
      final size = await file.length();

      final newItem = DownloadItem(
        id: episodeId,
        dramaId: dramaId,
        dramaTitle: dramaTitle,
        episodeNo: episodeNo,
        episodeTitle: episodeTitle,
        localPath: localPath,
        sizeInBytes: size,
      );

      _completedDownloads.add(newItem);
      await _saveDownloads();
      
      _downloadProgress.remove(episodeId);
      _cancelTokens.remove(episodeId);
      notifyListeners();
    } catch (e) {
      print('Download failed: $e');
      _downloadProgress.remove(episodeId);
      _cancelTokens.remove(episodeId);
      notifyListeners();
    }
  }

  // Cancel active download
  void cancelDownload(String episodeId) {
    if (_cancelTokens.contains(episodeId)) {
      // Dio download throws error and removes itself
      _cancelTokens.remove(episodeId);
      _downloadProgress.remove(episodeId);
      notifyListeners();
    }
  }

  // Delete completed download
  Future<void> deleteDownload(String episodeId) async {
    final index = _completedDownloads.indexWhere((d) => d.id == episodeId);
    if (index != -1) {
      final item = _completedDownloads[index];
      final file = File(item.localPath);
      if (await file.exists()) {
        await file.delete();
      }
      
      _completedDownloads.removeAt(index);
      await _saveDownloads();
      notifyListeners();
    }
  }

  bool isDownloaded(String episodeId) {
    return _completedDownloads.any((d) => d.id == episodeId);
  }

  bool isDownloading(String episodeId) {
    return _downloadProgress.containsKey(episodeId);
  }

  double getProgress(String episodeId) {
    return _downloadProgress[episodeId] ?? 0.0;
  }
}
