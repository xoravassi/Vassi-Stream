#include "audio_queue.h"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <thread>

// Cette fonction arrete le test avec un message precis quand une condition echoue.
static void require(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "ECHEC: " << message << '\n';
    std::exit(1);
  }
}

// Cette fonction compare deux samples avec une tolerance adaptee aux doubles du test.
static bool same_sample(double actual, double expected) {
  return std::abs(actual - expected) < 0.000000001;
}

// Cette fonction lit un sample stereo et verifie sa valeur exacte.
static void require_next(t_audio_queue *queue, double expected_left, double expected_right) {
  double left[1] = {0.0};
  double right[1] = {0.0};
  const std::size_t count = audio_queue_pop(queue, 1, left, right);

  require(count == 1, "la queue doit fournir un sample");
  require(same_sample(left[0], expected_left), "le sample gauche doit conserver son ordre");
  require(same_sample(right[0], expected_right), "le sample droit doit conserver son ordre");
}

// Cette fonction verifie l'ordre stereo sans overflow.
static void test_stereo_order() {
  t_audio_queue queue;
  audio_queue_construct(&queue);
  require(audio_queue_create(&queue, 4), "la creation de la queue doit reussir");

  const double left[] = {1.0, 2.0, 3.0};
  const double right[] = {-1.0, -2.0, -3.0};
  audio_queue_push_stereo(&queue, left, right, 3);

  require(audio_queue_size(&queue) == 3, "la taille doit correspondre aux samples ecrits");
  require_next(&queue, 1.0, -1.0);
  require_next(&queue, 2.0, -2.0);
  require_next(&queue, 3.0, -3.0);
  require(audio_queue_size(&queue) == 0, "la queue doit etre vide apres lecture");

  audio_queue_destroy(&queue);
  audio_queue_destruct(&queue);
}

// Cette fonction verifie qu'une lecture groupee copie chaque frame stereo.
static void test_block_read() {
  t_audio_queue queue;
  audio_queue_construct(&queue);
  require(audio_queue_create(&queue, 4), "la creation de la queue groupee doit reussir");

  const double input_left[] = {1.0, 2.0, 3.0};
  const double input_right[] = {-1.0, -2.0, -3.0};
  double output_left[3] = {0.0, 0.0, 0.0};
  double output_right[3] = {0.0, 0.0, 0.0};
  audio_queue_push_stereo(&queue, input_left, input_right, 3);
  const std::size_t count = audio_queue_pop(&queue, 3, output_left, output_right);

  require(count == 3, "la lecture groupee doit retourner toutes les frames");
  for (std::size_t frame = 0; frame < count; frame += 1) {
    require(same_sample(output_left[frame], input_left[frame]), "le bloc gauche doit rester ordonne");
    require(same_sample(output_right[frame], input_right[frame]), "le bloc droit doit rester ordonne");
  }

  audio_queue_destroy(&queue);
  audio_queue_destruct(&queue);
}

// Cette fonction verifie que l'overflow conserve uniquement l'audio le plus recent.
static void test_overflow() {
  t_audio_queue queue;
  audio_queue_construct(&queue);
  require(audio_queue_create(&queue, 4), "la creation de la queue d'overflow doit reussir");

  const double first_left[] = {1.0, 2.0, 3.0};
  const double first_right[] = {-1.0, -2.0, -3.0};
  const double second_left[] = {4.0, 5.0, 6.0};
  const double second_right[] = {-4.0, -5.0, -6.0};
  audio_queue_push_stereo(&queue, first_left, first_right, 3);
  audio_queue_push_stereo(&queue, second_left, second_right, 3);

  require(audio_queue_size(&queue) == 4, "la taille ne doit jamais depasser la capacite");
  require(queue.overflow_count.load(std::memory_order_relaxed) == 1, "l'overflow doit etre compte une fois");
  require(queue.dropped_frames.load(std::memory_order_relaxed) == 2, "les deux frames perdues doivent etre comptees");
  require_next(&queue, 3.0, -3.0);
  require_next(&queue, 4.0, -4.0);
  require_next(&queue, 5.0, -5.0);
  require_next(&queue, 6.0, -6.0);

  audio_queue_destroy(&queue);
  audio_queue_destruct(&queue);
}

// Cette fonction verifie qu'un bloc trop grand garde ses derniers samples.
static void test_oversized_block() {
  t_audio_queue queue;
  audio_queue_construct(&queue);
  require(audio_queue_create(&queue, 4), "la creation de la queue de grand bloc doit reussir");

  const double left[] = {1.0, 2.0, 3.0, 4.0, 5.0, 6.0};
  const double right[] = {-1.0, -2.0, -3.0, -4.0, -5.0, -6.0};
  audio_queue_push_stereo(&queue, left, right, 6);

  require(audio_queue_size(&queue) == 4, "un grand bloc doit rester borne a la capacite");
  require_next(&queue, 3.0, -3.0);
  require_next(&queue, 4.0, -4.0);
  require_next(&queue, 5.0, -5.0);
  require_next(&queue, 6.0, -6.0);

  audio_queue_destroy(&queue);
  audio_queue_destruct(&queue);
}

// Cette fonction verifie le redimensionnement, le silence d'un canal absent et le reset.
static void test_resize_missing_channel_and_reset() {
  t_audio_queue queue;
  audio_queue_construct(&queue);
  require(!audio_queue_create(&queue, 0), "une capacite nulle doit etre refusee");
  require(audio_queue_create(&queue, 2), "la creation de la queue de silence doit reussir");
  require(audio_queue_resize(&queue, 4), "le redimensionnement doit reussir hors DSP");
  require(queue.capacity_frames == 4, "la nouvelle capacite doit etre appliquee");

  const double right[] = {7.0, 8.0};
  audio_queue_push_stereo(&queue, nullptr, right, 2);
  require_next(&queue, 0.0, 7.0);
  require_next(&queue, 0.0, 8.0);

  audio_queue_push_stereo(&queue, nullptr, right, 2);
  audio_queue_push_stereo(&queue, nullptr, right, 2);
  audio_queue_push_stereo(&queue, nullptr, right, 2);
  require(queue.overflow_count.load(std::memory_order_relaxed) == 1, "le test doit provoquer un overflow avant reset");
  audio_queue_reset(&queue);
  require(audio_queue_size(&queue) == 0, "reset doit vider la queue");
  require(queue.overflow_count.load(std::memory_order_relaxed) == 0, "reset doit remettre l'overflow a zero");
  require(queue.dropped_frames.load(std::memory_order_relaxed) == 0, "reset doit remettre les frames perdues a zero");

  audio_queue_destroy(&queue);
  audio_queue_destruct(&queue);
}

// Cette fonction verifie la coherence stereo pendant des acces concurrents prolonges.
static void test_concurrent_access() {
  t_audio_queue queue;
  audio_queue_construct(&queue);
  require(audio_queue_create(&queue, 64), "la creation de la queue concurrente doit reussir");
  require(audio_queue_is_lock_free(&queue), "les atomiques audio doivent etre sans verrou");

  std::atomic<bool> producer_done(false);
  std::atomic<bool> invalid_sample(false);
  std::atomic<unsigned long long> samples_read(0);

  std::thread producer([&queue, &producer_done]() {
    for (unsigned long long index = 1; index <= 200000; index += 1) {
      const double left = (double)index;
      const double right = -(double)index;
      audio_queue_push_stereo(&queue, &left, &right, 1);
    }
    producer_done.store(true, std::memory_order_release);
  });

  std::thread consumer([&queue, &producer_done, &invalid_sample, &samples_read]() {
    double previous_left = 0.0;
    while (!producer_done.load(std::memory_order_acquire) || audio_queue_size(&queue) > 0) {
      double left[1] = {0.0};
      double right[1] = {0.0};
      if (audio_queue_pop(&queue, 1, left, right) == 0) {
        std::this_thread::yield();
        continue;
      }
      if (left[0] <= previous_left || !same_sample(right[0], -left[0])) {
        invalid_sample.store(true, std::memory_order_relaxed);
      }
      previous_left = left[0];
      samples_read.fetch_add(1, std::memory_order_relaxed);
    }
  });

  producer.join();
  consumer.join();

  require(!invalid_sample.load(std::memory_order_relaxed), "la concurrence doit conserver l'ordre et les paires stereo");
  require(samples_read.load(std::memory_order_relaxed) > 0, "le worker de test doit lire des samples");
  require(audio_queue_size(&queue) == 0, "la queue concurrente doit finir vide");

  audio_queue_destroy(&queue);
  audio_queue_destruct(&queue);
}

// Cette fonction verifie que reset ne fait jamais reculer l'index de lecture pendant l'ecriture.
static void test_concurrent_reset() {
  t_audio_queue queue;
  audio_queue_construct(&queue);
  require(audio_queue_create(&queue, 1), "la creation de la queue de reset concurrent doit reussir");

  std::atomic<bool> producer_done(false);
  std::atomic<bool> reset_done(false);
  std::atomic<bool> read_moved_back(false);

  std::thread producer([&queue, &producer_done]() {
    for (unsigned long long index = 1; index <= 1000000; index += 1) {
      const double left = (double)index;
      const double right = -(double)index;
      audio_queue_push_stereo(&queue, &left, &right, 1);
    }
    producer_done.store(true, std::memory_order_release);
  });

  std::thread resetter([&queue, &reset_done]() {
    for (unsigned long long index = 0; index < 1000000; index += 1) {
      audio_queue_reset(&queue);
    }
    reset_done.store(true, std::memory_order_release);
  });

  std::thread observer([&queue, &producer_done, &reset_done, &read_moved_back]() {
    t_queue_count previous_read = queue.read_frame.load(std::memory_order_acquire);
    while (!producer_done.load(std::memory_order_acquire) || !reset_done.load(std::memory_order_acquire)) {
      const t_queue_count current_read = queue.read_frame.load(std::memory_order_acquire);
      if (current_read < previous_read) {
        read_moved_back.store(true, std::memory_order_relaxed);
      }
      previous_read = current_read;
    }
  });

  producer.join();
  resetter.join();
  observer.join();

  require(!read_moved_back.load(std::memory_order_relaxed), "reset ne doit jamais faire reculer la lecture");

  audio_queue_destroy(&queue);
  audio_queue_destruct(&queue);
}

// Cette fonction execute tous les controles natifs du bloc 3.
int main() {
  test_stereo_order();
  test_block_read();
  test_overflow();
  test_oversized_block();
  test_resize_missing_channel_and_reset();
  test_concurrent_access();
  test_concurrent_reset();
  std::cout << "OK: tous les tests natifs de la queue audio passent\n";
  return 0;
}
