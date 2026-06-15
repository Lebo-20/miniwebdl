class DramaModel {
  final String id;
  final String title;
  final String platform;
  final int episodes;
  final String genre;
  final String country;
  final String year;
  final bool vip;
  final String rating;
  final String synopsis;
  final String poster;
  final String backdrop;
  final String tone;
  final bool isFallback;

  DramaModel({
    required this.id,
    required this.title,
    required this.platform,
    required this.episodes,
    required this.genre,
    required this.country,
    required this.year,
    required this.vip,
    required this.rating,
    required this.synopsis,
    required this.poster,
    required this.backdrop,
    required this.tone,
    this.isFallback = false,
  });

  factory DramaModel.fromJson(Map<String, dynamic> json) {
    return DramaModel(
      id: json['id'] ?? '',
      title: json['title'] ?? json['name'] ?? '',
      platform: json['platform'] ?? '',
      episodes: json['episodes'] is int ? json['episodes'] : int.tryParse(json['episodes']?.toString() ?? '0') ?? 0,
      genre: json['genre'] ?? '',
      country: json['country'] ?? '',
      year: json['year']?.toString() ?? '',
      vip: json['vip'] ?? false,
      rating: json['rating']?.toString() ?? '0.0',
      synopsis: json['synopsis'] ?? '',
      poster: json['poster'] ?? '',
      backdrop: json['backdrop'] ?? '',
      tone: json['tone'] ?? 'blue',
      isFallback: json['isFallback'] ?? false,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'platform': platform,
      'episodes': episodes,
      'genre': genre,
      'country': country,
      'year': year,
      'vip': vip,
      'rating': rating,
      'synopsis': synopsis,
      'poster': poster,
      'backdrop': backdrop,
      'tone': tone,
      'isFallback': isFallback,
    };
  }
}
