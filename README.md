# CityScene

> **English summary.** CityScene is a pipeline that exports a Blender scene to glTF (Python scripts run inside Blender: material baking, light conversion, collision mesh) and a React Three Fiber web app that lets you explore it in the browser: aerial, orbit and first-person street walk-through with collision, plus night, golden-hour and daytime lighting modes. This repository contains the code only. The 3D scene itself is third-party work and is not included, so you must supply your own `.blend` file (see "Lisans ve varlıklar" below). No live demo is provided because the scene assets are third-party.

CityScene, Blender'da hazırlanmış bir sahneyi (`CityScene.blend`) tarayıcıda gezmenizi sağlar. Blender dosyası dışa aktarılır, web uygulaması bu çıktıyı gösterir: havadan, yörüngeden ya da sokak seviyesinde yürüyerek. Bu depoda yalnızca kod bulunur; 3D sahnenin kendisi depoda yoktur (bkz. "Lisans ve varlıklar"). Sahne varlıkları üçüncü kişiye ait olduğu için canlı demo sunulmaz.

## Gereksinimler

- Blender 5.2 (`build_all.py` varsayılan olarak `D:/BLENDER/blender.exe` yolunu dener; farklı bir konumdaysa `--blender` ile değiştirin)
- Node.js ve pnpm
- Python 3.11 (`py -3.11`)
- Masaüstü Chrome veya Edge, WebGL 2 desteğiyle

Kendi `.blend` dosyanızı proje klasörünün köküne `CityScene.blend` adıyla koyun (ya da `--blend` ile yolunu verin). `.blend` dosyaları Git'e eklenmez.

## İlk kurulum

Proje klasöründe bir terminal açın ve paketleri kurun:

```bash
pnpm --dir web install --frozen-lockfile
```

Dışa aktarılmış sahne dosyaları (`web/public/models`, `web/public/data`) depoda yoktur; uygulamayı çalıştırmadan önce `py -3.11 build_all.py` ile üretmeniz gerekir (aşağıya bakın).

## Çalıştırma

Geliştirme sunucusu (adres: http://localhost:5283):

```bash
pnpm --dir web run dev --port 5283 --strictPort
```

Üretim sürümü: önce derleyin, sonra önizleyin (adres: http://localhost:5284):

```bash
pnpm --dir web run build
pnpm --dir web run preview --port 5284 --strictPort
```

Yüklemede shader ve dokular hazırlanırken yaklaşık 9 saniye beklemeniz gerekir; ekranda yükleme göstergesi görünür.

## Sahneyi dışa aktarma

`CityScene.blend` dosyasını (Blender'da düzenlediyseniz kaydedin, Blender'ı kapatın ya da dosyayı başka bir kopyaya kaydedin) ve tek komutu çalıştırın:

```bash
py -3.11 build_all.py
```

Komut sırayla şunları yapar ve ilk hatada durur: `.blend` dosyasının var olduğunu denetler, Python testleri, Blender'dan dışa aktarma, paket kurulumu, modellerin sıkıştırılması, çıktıların doğrulanması, web testleri, üretim derlemesi. Doğrulama adımı `city.glb` ve `collision.glb` gerçek GLB dosyası değilse, `city.glb` meshopt ile sıkıştırılmamışsa ya da 100 MB'ı aşıyorsa, çarpışma modelinde üçgen ya da sahnede ışık yoksa derlemeyi durdurur. Sonda üçgen, ışık, malzeme yolları (bake / gltf / override sayıları), bake sayısı, model boyutu (MB), süre ve dışa aktarmanın her uyarısı yazılır; aynı özet `web/public/data/build_report.json` dosyasına kaydedilir.

Blender'da render'a kapalı nesneler (kamera simgesi, render'a kapalı ya da görünüm katmanından çıkarılmış koleksiyon) web'e aktarılmaz ve çarpışmaz. Yalnızca görünümde gizli nesneler (göz simgesi) Blender'ın render'ında göründüğü için web'de de görünür ve çarpışır.

İlk çalıştırmada prosedürel malzemeler dokuya "bake" edilir ve bu birkaç dakika sürer. Sonuçlar `blender/cache/` altında saklanır; sonraki çalıştırmalarda değişmeyen malzemeler önbellekten gelir ve komut yaklaşık bir dakikada biter.

Seçenekler:

| Seçenek | Ne yapar |
| --- | --- |
| `--blender <yol>` | Başka bir `blender.exe` kullanır (varsayılan `D:/BLENDER/blender.exe`; kendi kurulumunuza göre `--blender ile değiştirin`) |
| `--blend <yol>` | Başka bir `.blend` dosyasını dışa aktarır. `config/export_config.json` değişmez, geçici bir config kopyası kullanılır |
| `--skip-tests` | Python ve web testlerini atlar |
| `--no-bake` | Prosedürel malzemeleri bake etmez |

## Kamera modları

| Mod | Fare | Klavye |
| --- | --- | --- |
| Havadan | Sol tuş kaydırır, sağ tuş döndürür, tekerlek yakınlaştırır | Yok |
| Yörünge | Sol tuş döndürür, sağ tuş kaydırır, tekerlek yakınlaştırır | Yok |
| Sokak | Sürükleyerek bakarsınız. "Fareyi kilitle" ile sürüklemeden bakılır, Esc kilidi bırakır | W A S D veya oklar yürür, Shift koşturur |

## Işık modları

Arayüzdeki "Işık" kontrolüyle üç mod arasında geçilir. Açılış modu Gece'dir.

| Mod | Görünüm |
| --- | --- |
| Gündüz | Fotoğraf gökyüzü (güneş yüksekliği 50°, azimut 145°), tek yönlü güneş ve gölgeler. Gece ışıkları ve ışık havuzları kapanır, neon ve pencere parlaması kısılır. |
| Altın saat | Alçak ve sıcak güneş (yükseklik 9°, azimut 258°), üretilmiş gradyan gökyüzü, uzun gölgeler. |
| Gece | Önceki gibi: gece gökyüzü, sokak ışıkları, ışık havuzları ve parlama. Gölge yoktur. |

- Gündüz ve altın saatte güneş, tüm sahneyi kapsayan sabit bir gölge haritasıyla (2048²) gölge düşürür; harita kamerayı izlemez.
- Mod değişiminde yükleme ekranı çıkmaz. Gündüz göğü ilk seçildiğinde yüklenir ve gölgelendiriciler derlenir; bu sırada panelde "Işık hazırlanıyor…" yazar. Sonraki geçişler anlıktır.
- Gündüz göğü yüklenemezse sahne üretilmiş gökyüzüyle gündüz renklerinde açılır.
- Gece, ışık modlarından önceki haliyle aynıdır. Gece ışığına dönüşte ışık havuzları ve parlama gece değerlerine birebir geri gelir.

### Gökyüzü kaynağı

Gündüz gökyüzü, Poly Haven'ın "kloofendal_48d_partly_cloudy_puresky" HDRI'sıdır (lisans CC0 1.0, kamu malı). Dosyalar `web/public/textures/` altındadır: `sky_env.hdr` (ortam ışığı), `sky_high.webp` (4096 px) ve `sky_low.webp` (2048 px, hızlı ilk görüntü). Kaynak: https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky

## Çarpışma

Sokak modunda duvarlardan geçemezsiniz. Ön cephesi açık olan binalara (örneğin girişi açık dükkânlar) girilebilir; kapalı binalar duvar gibidir. Cam da katıdır, camın içinden geçilmez.

## Bilinen sınırlar

- Tarayıcıda Cycles kalitesi yoktur; ışık, gölge ve yansımalar Blender'daki render'dan daha yalındır.
- Sahnedeki ışıkların (örnek sahnede 176) yalnızca kameraya en yakın 12'si (6 nokta, 6 spot/alan) gerçek ışıktır. Diğerleri zeminde yumuşak bir ışık havuzu olarak çizilir; bu havuzlar duvarları aydınlatmaz. Havadan bakınca sokaklar bu havuzlarla aydınlık görünür.
- Lambalar gölge düşürmez (gece modunda hiçbir şey gölge düşürmez): lamba gövdesinin ya da duvarın arkasındaki bir ışık, Blender'da karanlık kalan yerleri de aydınlatabilir. Gündüz ve altın saatte yalnızca güneş gölge düşürür.
- Parlama (bloom) havadan ve yörüngede bilerek zayıftır; tabelaların neon parlaması sokak modunda belirgindir.
- Bazı ışıklı tabelalar ve panolar Blender'daki kadar parlak görünmeyebilir (aydınlatan alan ışıkları, gerçek ışık havuzundaki sınırlı yer için diğer ışıklarla yarışır).
- Sokak modunda sahnenin sınırından ve zeminin kenarından dışarı çıkılamaz; doğu tarafında yürüyüş, sınıra varmadan binalarla kesilir.
- Neon çizimler siyah zemin üzerinde görünür.
- Yol dokusu yakından bakınca biraz yumuşaktır; gündüz ışığında bu daha çok fark edilir.
- Gündüz ve altın saatte zemin düz bir renktir (gökyüzünün altında dokusuz bir zemin çizilir); neon arka plakaları da gündüz daha görünürdür.
- Gündüze ilk geçiş gökyüzü yüklemesi ve gölgelendirici derlemesi yüzünden yaklaşık 2–4 saniye sürebilir; sonraki geçişler hızlıdır.
- Açılışta yaklaşık 9 saniyelik hazırlık süresi vardır.

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| WebGL hatası | Tarayıcının donanım hızlandırma ayarını açın ve Chrome ya da Edge'in güncel olduğundan emin olun. WebGL 2 gereklidir |
| Yavaşlık, takılma | Windows Ayarlar > Sistem > Ekran > Grafik bölümünde tarayıcıyı ekleyip "Yüksek performans" GPU'sunu seçin; pencereyi küçültmek de yardımcı olur |
| Uçtan uca raporda `renderer` NVIDIA değil | Chrome tümleşik GPU'yu kullanıyor demektir; Windows Ayarlar > Sistem > Ekran > Grafik bölümünde Chrome'u (`chrome.exe`) "Yüksek performans" (NVIDIA) olarak ayarlayıp testi yeniden çalıştırın. FPS ölçütü yalnızca NVIDIA ile sayılır |
| "Sokak modu kullanılamıyor" notu | Çarpışma verisi yüklenemedi demektir. `web/public/models/collision.glb` dosyasının var olduğunu kontrol edin; yoksa `py -3.11 build_all.py` çalıştırın |
| Dosya bulunamadı hatası | Dışa aktarılmış dosyalar eksik olabilir; `py -3.11 build_all.py` komutunu çalıştırın |
| Dışa aktarma "CS_EXPORT_OK" satırı olmadan bitti | Blender'da dosya açık ve kilitli olabilir ya da yol yanlıştır; `--blender` ve `--blend` yollarını kontrol edin |
| Dışa aktarma bir önbellek dokusunu okurken hata verdi | Export bir önbellek dokusunu okurken hata verirse `blender/cache/` klasörünü silin ve `py -3.11 build_all.py` komutunu yeniden çalıştırın (ilk çalıştırma gibi birkaç dakika sürer) |
| "FAILED: Validate outputs" | Çıktılardan biri bozuk ya da eksik demektir; satırların üstündeki `PROBLEM:` satırları nedenini söyler. `py -3.11 build_all.py` komutunu yeniden çalıştırın |

## Testler

Hızlı testler (saniyeler sürer):

```bash
py -3.11 -m unittest tests.test_scene_rules tests.test_build_all
pnpm --dir web run test
```

Yavaş testler Blender'ı çalıştırır ve dakikalar sürer:

```bash
py -3.11 -m unittest tests.test_export_output
py -3.11 -m unittest tests.test_bake
```

`py -3.11 -m unittest tests.test_export_output.VisibilityExportTest` yalnızca görünürlük kuralını (gizli ve render'a kapalı nesneler) küçük bir deneme sahnesinde birkaç saniyede sınar.

## Ekran görüntüsü aracı

Üretim derlemesinden ekran görüntüsü alır (önce `pnpm --dir web run build`; araç kendi önizleme sunucusunu 5284 portunda açar, o port boş olmalıdır). Görüntüler `docs/screenshots/` altına yazılır (bu klasör Git'e eklenmez):

```bash
pnpm --dir web run screenshot -- --tag x
```

## Uçtan uca test

Üretim derlemesini sistemdeki Chrome ile (geçici profil, ekran kartıyla) açar; 1600×900 ve 1920×1080 pencerede (DPR 1) her kamera modunda 10 saniyelik ortalama FPS'i, çizim ve üçgen sayısını, kullanılan GPU'yu (`renderer`) ölçer. Sokak modunda üç sabit noktadan görüntü alır, duvara yürüme, zemini izleme ve sahne kenarından düşmeme denetimlerini yapar. Sonuç `web/e2e/report.json` dosyasına (Git'e eklenmez), ekran görüntüleri `docs/screenshots/` altına (Git'e eklenmez) yazılır. Tarayıcı konsolunda hata varsa ya da denetimlerden biri geçmezse çıkış kodu 1'dir; geçmeyen denetimler raporda `failedChecks` altında listelenir. Denetimler açılış noktasını, duvara yürümeyi, zemini izlemeyi, sahne kenarından düşmemeyi, `.blend` dosyasının dışa aktarmadan sonra değişmediğini, 1080p sokak FPS'ini ve ışık modları turunu (çizim, doku ve geometri sayıları ikinci turda aynı kalmalıdır; gece görünümü tur sonrasında değişmemelidir) kapsar. Ek olarak 1920×1080'de her ışık modunda üç sokak noktasında FPS ölçülür. NVIDIA dışı bir GPU'da ölçülen FPS hata sayılmaz. Bu test, dışa aktarılmış sahne dosyalarını gerektirir (önce `py -3.11 build_all.py`).

```bash
pnpm --dir web run build
pnpm --dir web run e2e
pnpm --dir web run e2e -- --uncapped --report report_uncapped.json
pnpm --dir web run e2e -- --compare
```

- `--uncapped`: ekranın 60 Hz sınırını kaldırır; kartın ne kadar pay bıraktığını gösterir.
- `--compare`: aynı kameraları arka planda açılan Blender'da çizip web görüntüsüyle yan yana birleştirir (Blender görüntüleri birkaç dakika sürer; `--compose` var olan Blender görüntüleriyle yalnızca birleştirir). Çıktılar `docs/screenshots/` altına yazılır.

## Lisans ve varlıklar

- **Kod** (bu depodaki tüm betikler, web uygulaması ve testler) MIT lisansıyla yayımlanmıştır; bkz. `LICENSE`.
- **3D sahne ve modeller bu depoda YOKTUR.** Sahne tasarımı kendi sahibine aittir ve burada dağıtılmaz. `web/public/models/`, `web/public/data/` ve gece gökyüzü (`web/public/textures/sky.hdr`) Git'e eklenmez (`.gitignore`).
- Uygulamayı çalıştırmak için kendi `.blend` dosyanızı sağlamanız gerekir: dosyayı proje köküne `CityScene.blend` adıyla koyun ya da `--blend <yol>` verin, sonra `py -3.11 build_all.py` komutunu çalıştırın; bu komut `web/public/models`, `web/public/data` ve gece gökyüzü dokusunu üretir. Sahnenizdeki nesne adlarına göre `config/export_config.json` içindeki `exclude_objects` ve `collision.exclude` listelerini düzenlemeniz gerekebilir.
- Gündüz gökyüzü fotoğrafı (`sky_env.hdr`, `sky_high.webp`, `sky_low.webp`) Poly Haven'dan, CC0 1.0 (kamu malı) lisansıyla alınmıştır: https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
