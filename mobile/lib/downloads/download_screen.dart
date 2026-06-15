import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/download_provider.dart';

class DownloadScreen extends StatelessWidget {
  const DownloadScreen({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final download = Provider.of<DownloadProvider>(context);
    final list = download.completedDownloads;

    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text('Unduhan Offline', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
      ),
      body: list.isEmpty
          ? const Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.download, size: 64, color: Colors.white10),
                  SizedBox(height: 12),
                  Text('Belum ada video yang diunduh.', style: TextStyle(color: Colors.white38)),
                ],
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: list.length,
              itemBuilder: (context, index) {
                final item = list[index];
                final sizeMB = (item.sizeInBytes / (1024 * 1024)).toStringAsFixed(1);

                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  decoration: BoxDecoration(
                    color: const Color(0xFF102846),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: ListTile(
                    onTap: () {
                      Navigator.pushNamed(context, '/watch', arguments: {
                        'dramaId': item.dramaId,
                        'episodeId': item.episodeNo.toString(),
                      });
                    },
                    leading: const CircleAvatar(
                      backgroundColor: Color(0xFFFFD700),
                      child: Icon(Icons.play_arrow, color: Color(0xFF071424)),
                    ),
                    title: Text(
                      item.dramaTitle,
                      style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                    subtitle: Text(
                      '${item.episodeTitle} • $sizeMB MB',
                      style: const TextStyle(color: Colors.white54, fontSize: 12),
                    ),
                    trailing: IconButton(
                      icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
                      onPressed: () {
                        _showDeleteConfirm(context, download, item);
                      },
                    ),
                  ),
                );
              },
            ),
    );
  }

  void _showDeleteConfirm(BuildContext context, DownloadProvider download, DownloadItem item) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF102846),
        title: const Text('Hapus Unduhan', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: Text('Apakah Anda yakin ingin menghapus ${item.dramaTitle} - ${item.episodeTitle} dari penyimpanan?', style: const TextStyle(color: Colors.white70)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Batal', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              await download.deleteDownload(item.id);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Unduhan berhasil dihapus.'), backgroundColor: Colors.redAccent),
              );
            },
            child: const Text('Hapus', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
  }
}
