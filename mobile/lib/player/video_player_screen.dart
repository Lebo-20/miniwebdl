import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:video_player/video_player.dart';
import 'package:chewie/chewie.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import '../providers/auth_provider.dart';
import '../providers/playback_provider.dart';
import '../providers/download_provider.dart';
import '../services/api_service.dart';
import '../models/drama_model.dart';

class VideoPlayerScreen extends StatefulWidget {
  final String dramaId;
  final String episodeId;

  const VideoPlayerScreen({
    Key? key,
    required this.dramaId,
    required this.episodeId,
  }) : super(key: key);

  @override
  State<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends State<VideoPlayerScreen> {
  final ApiService _api = ApiService();
  VideoPlayerController? _videoController;
  ChewieController? _chewieController;
  bool _isLoading = true;
  String? _errorMessage;
  
  late DramaModel _drama;
  late int _episodeNo;
  String _streamUrl = '';
  bool _isOfflinePlay = false;

  @override
  void initState() {
    super.initState();
    _episodeNo = int.tryParse(widget.episodeId) ?? 1;
    _initializePlayer();
  }

  Future<void> _initializePlayer() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    final playback = Provider.of<PlaybackProvider>(context, listen: false);
    final downloads = Provider.of<DownloadProvider>(context, listen: false);
    
    _drama = playback.dramas.firstWhere((d) => d.id == widget.dramaId);

    // 1. Check if episode is downloaded for offline play
    final downloadMatches = downloads.completedDownloads.where(
      (d) => d.dramaId == widget.dramaId && d.episodeNo == _episodeNo
    );

    if (downloadMatches.isNotEmpty) {
      final downloadItem = downloadMatches.first;
      final file = File(downloadItem.localPath);
      if (await file.exists()) {
        _isOfflinePlay = true;
        _streamUrl = downloadItem.localPath;
        _setupVideoController(VideoPlayerController.file(file));
        return;
      }
    }

    // 2. Fetch signed video URL from API
    try {
      final String launchKey = '${_drama.platform.toLowerCase()}-${_drama.id}';
      
      // Request signed path from backend (e.g. /api/secure-media/...)
      final resolvedPath = await _api.getStreamUrl(launchKey, widget.episodeId);
      _streamUrl = _api.baseUrl + resolvedPath;

      print('Loading video stream from: $_streamUrl');
      _setupVideoController(VideoPlayerController.networkUrl(Uri.parse(_streamUrl)));
    } catch (e) {
      _logError(e.toString());
      setState(() {
        _isLoading = false;
        _errorMessage = 'Gagal memuat link video: $e';
      });
    }
  }

  void _setupVideoController(VideoPlayerController controller) async {
    _videoController = controller;
    
    try {
      await _videoController!.initialize();
      
      // Load saved progress for auto-resume
      final savedProgress = _getSavedProgress();
      if (savedProgress > 0) {
        final resumePosition = Duration(milliseconds: (_videoController!.value.duration.inMilliseconds * savedProgress).toInt());
        await _videoController!.seekTo(resumePosition);
      }

      // Configure Chewie premium controls
      _chewieController = ChewieController(
        videoPlayerController: _videoController!,
        autoPlay: true,
        looping: false,
        aspectRatio: _videoController!.value.aspectRatio,
        allowFullScreen: true,
        allowPlaybackSpeedChanging: true,
        showControls: true,
        placeholder: Container(color: Colors.black),
        materialProgressColors: ChewieProgressColors(
          playedColor: const Color(0xFFFFD700),
          handleColor: const Color(0xFFFFD700),
          bufferedColor: Colors.white24,
          backgroundColor: Colors.white12,
        ),
      );

      // Listen to playback progress changes to update Watch History
      _videoController!.addListener(_onPlaybackUpdate);

      setState(() {
        _isLoading = false;
      });
    } catch (e) {
      _logError(e.toString());
      setState(() {
        _isLoading = false;
        _errorMessage = 'Terjadi kesalahan saat memutar video: $e';
      });
    }
  }

  double _getSavedProgress() {
    final playback = Provider.of<PlaybackProvider>(context, listen: false);
    final historyItem = playback.history[widget.dramaId];
    if (historyItem != null && historyItem['episodeNo'] == _episodeNo) {
      return historyItem['progress'] is double 
          ? historyItem['progress'] 
          : (double.tryParse(historyItem['progress']?.toString() ?? '0.0') ?? 0.0);
    }
    return 0.0;
  }

  void _onPlaybackUpdate() {
    if (_videoController == null || !_videoController!.value.isInitialized) return;
    
    final position = _videoController!.value.position;
    final duration = _videoController!.value.duration;
    
    if (duration.inSeconds > 0) {
      final progress = position.inMilliseconds / duration.inMilliseconds;
      
      // Throttle sync frequency to once every 10 seconds or when finished
      final isFinished = progress >= 0.98;
      
      final auth = Provider.of<AuthProvider>(context, listen: false);
      if (auth.isAuthenticated) {
        final playback = Provider.of<PlaybackProvider>(context, listen: false);
        playback.updateWatchHistory(
          userId: auth.user!.userId,
          drama: _drama,
          episodeNo: _episodeNo,
          episodeName: 'Episode $_episodeNo',
          progress: isFinished ? 1.0 : progress,
        );
      }
    }
  }

  // Report Playback failures back to CDN Monitor on Admin panel
  void _logError(String details) {
    final auth = Provider.of<AuthProvider>(context, listen: false);
    if (auth.isAuthenticated) {
      _api.logStreamError(
        dramaTitle: _drama.title,
        episodeName: 'Episode $_episodeNo',
        errorType: _isOfflinePlay ? 'OFFLINE_PLAYBACK_ERROR' : 'CDN_PROXY_ERROR',
        cdn: _drama.platform,
        userId: auth.user!.userId
      );
    }
  }

  @override
  void dispose() {
    _videoController?.removeListener(_onPlaybackUpdate);
    _videoController?.dispose();
    _chewieController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Column(
          children: [
            // Top Nav bar for video player (Overlay)
            _buildPlayerHeader(context),

            // Video Display
            Expanded(
              child: Center(
                child: _isLoading
                    ? const SpinKitRing(color: Color(0xFFFFD700), size: 48, lineWidth: 3)
                    : _errorMessage != null
                        ? _buildErrorPlaceholder()
                        : AspectRatio(
                            aspectRatio: _videoController!.value.aspectRatio,
                            child: Chewie(controller: _chewieController!),
                          ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPlayerHeader(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      color: Colors.black,
      child: Row(
        children: [
          IconButton(
            icon: const Icon(Icons.arrow_back, color: Colors.white),
            onPressed: () => Navigator.pop(context),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _drama.title,
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  'Episode $_episodeNo ${_isOfflinePlay ? "(Offline)" : ""}',
                  style: const TextStyle(color: Colors.white54, fontSize: 12),
                ),
              ],
            ),
          ),
          // Download option if not already downloaded
          if (!_isOfflinePlay)
            Consumer<DownloadProvider>(
              builder: (context, download, child) {
                final isDown = download.isDownloaded(widget.episodeId);
                final isProgress = download.isDownloading(widget.episodeId);
                
                if (isDown) {
                  return const Icon(Icons.download_done, color: Colors.green);
                }
                
                if (isProgress) {
                  return SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(
                      value: download.getProgress(widget.episodeId),
                      strokeWidth: 2,
                      valueColor: const AlwaysStoppedAnimation(Color(0xFFFFD700)),
                    ),
                  );
                }

                return IconButton(
                  icon: const Icon(Icons.download, color: Colors.white),
                  onPressed: () {
                    download.startDownload(
                      episodeId: widget.episodeId,
                      dramaId: widget.dramaId,
                      dramaTitle: _drama.title,
                      episodeNo: _episodeNo,
                      episodeTitle: 'Episode $_episodeNo',
                      videoUrl: _streamUrl,
                    );
                    
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Mengunduh episode di latar belakang...'),
                        backgroundColor: Color(0xFF102846),
                      ),
                    );
                  },
                );
              },
            ),
        ],
      ),
    );
  }

  Widget _buildErrorPlaceholder() {
    return Padding(
      padding: const EdgeInsets.all(32.0),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, size: 64, color: Colors.redAccent),
          const SizedBox(height: 16),
          Text(
            _errorMessage ?? 'Gagal memutarkan video.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white70, fontSize: 14),
          ),
          const SizedBox(height: 24),
          ElevatedButton(
            onPressed: _initializePlayer,
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFFFFD700),
              foregroundColor: const Color(0xFF071424),
            ),
            child: const Text('COBA LAGI', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }
}
