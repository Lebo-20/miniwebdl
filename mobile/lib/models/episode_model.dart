class EpisodeModel {
  final String id;
  final int episodeNo;
  final String title;
  final String videoUrl;
  final bool locked;
  final String videoKey;
  final String accessDenied;
  final List<SubtitleTrack> subtitles;

  EpisodeModel({
    required this.id,
    required this.episodeNo,
    required this.title,
    required this.videoUrl,
    required this.locked,
    this.videoKey = '',
    this.accessDenied = '',
    this.subtitles = const [],
  });

  factory EpisodeModel.fromJson(Map<String, dynamic> json) {
    var subtitleList = <SubtitleTrack>[];
    if (json['subtitles'] != null) {
      subtitleList = (json['subtitles'] as List)
          .map((sub) => SubtitleTrack.fromJson(sub))
          .toList();
    } else if (json['subtitle'] != null) {
      if (json['subtitle'] is List) {
        subtitleList = (json['subtitle'] as List)
            .map((sub) => SubtitleTrack.fromJson(sub))
            .toList();
      } else if (json['subtitle'] is Map) {
        subtitleList = [SubtitleTrack.fromJson(json['subtitle'])];
      }
    }

    final rawNo = json['episodeNo'] ?? json['episodeNumber'] ?? json['chapterNo'] ?? json['ep'] ?? json['order'] ?? 0;

    return EpisodeModel(
      id: json['id']?.toString() ?? json['chapterId']?.toString() ?? json['episodeId']?.toString() ?? '',
      episodeNo: rawNo is int ? rawNo : int.tryParse(rawNo.toString()) ?? 0,
      title: json['title'] ?? json['name'] ?? json['chapterName'] ?? json['episodeName'] ?? '',
      videoUrl: json['url'] ?? json['videoUrl'] ?? json['stream_url'] ?? json['video_url'] ?? json['m3u8_url'] ?? '',
      locked: json['locked'] ?? false,
      videoKey: json['videoKey'] ?? json['videokey'] ?? json['video_key'] ?? '',
      accessDenied: json['accessDenied'] ?? '',
      subtitles: subtitleList,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'episodeNo': episodeNo,
      'title': title,
      'videoUrl': videoUrl,
      'locked': locked,
      'videoKey': videoKey,
      'accessDenied': accessDenied,
      'subtitles': subtitles.map((sub) => sub.toJson()).toList(),
    };
  }
}

class SubtitleTrack {
  final String language;
  final String label;
  final String url;

  SubtitleTrack({
    required this.language,
    required this.label,
    required this.url,
  });

  factory SubtitleTrack.fromJson(Map<String, dynamic> json) {
    return SubtitleTrack(
      language: json['lang'] ?? json['language'] ?? 'en',
      label: json['label'] ?? json['display_name'] ?? 'English',
      url: json['url'] ?? json['src'] ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'lang': language,
      'label': label,
      'url': url,
    };
  }
}
