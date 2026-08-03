cmake_minimum_required(VERSION 3.25)

project(vassi.encoder~)

# Le SDK place le binaire dans le dossier local ignore par le projet.
set(C74_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../.local/artifacts")
set(VASSI_DEPS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../.local/deps")
set(OPUS_DIR "${VASSI_DEPS_DIR}/opus-1.5.2")
set(SPEEXDSP_DIR "${VASSI_DEPS_DIR}/speexdsp-1.2.1")

# La configuration refuse une dependance absente pour garantir les versions compilees.
if(NOT EXISTS "${OPUS_DIR}/CMakeLists.txt" OR NOT EXISTS "${SPEEXDSP_DIR}/libspeexdsp/resample.c")
  message(FATAL_ERROR "Executez scripts/prepare-native-deps.cmd avant la compilation.")
endif()

# Le SDK fixe notamment le runtime C statique attendu par un external Max autonome.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../.local/max-sdk/source/max-sdk-base/script/max-pretarget.cmake)

# Opus est lie statiquement sans programmes, tests ni modules d'installation.
set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_STATIC_RUNTIME ON CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
add_subdirectory("${OPUS_DIR}" "${CMAKE_BINARY_DIR}/opus" EXCLUDE_FROM_ALL)

# Le projet compile uniquement le resampler flottant de SpeexDSP.
add_library(vassi_resampler STATIC "${SPEEXDSP_DIR}/libspeexdsp/resample.c")
target_compile_definitions(vassi_resampler PRIVATE OUTSIDE_SPEEX RANDOM_PREFIX=vassi_stream FLOATING_POINT)
target_include_directories(vassi_resampler PUBLIC
  "${SPEEXDSP_DIR}/include/speex"
  "${SPEEXDSP_DIR}/libspeexdsp"
)

#############################################################
# MAX EXTERNAL
#############################################################

include_directories(
  "${MAX_SDK_INCLUDES}"
  "${MAX_SDK_MSP_INCLUDES}"
  "${MAX_SDK_JIT_INCLUDES}"
)

file(GLOB PROJECT_SRC
  "source/*.h"
  "source/*.c"
  "source/*.cpp"
)

add_library(
  ${PROJECT_NAME}
  MODULE
  ${PROJECT_SRC}
)

# Le pont loopback vers node.script utilise les sockets Windows.
target_link_libraries(${PROJECT_NAME} PRIVATE Opus::opus vassi_resampler ws2_32)

# Ce binaire teste le resampling, les profils, la stereo et les resets avec libopus.
add_executable(vassi_audio_encoder_test
  "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/native/audio_encoder.test.cpp"
  "source/audio_encoder.cpp"
)
target_include_directories(vassi_audio_encoder_test PRIVATE "source")
target_link_libraries(vassi_audio_encoder_test PRIVATE Opus::opus vassi_resampler)

# Ce binaire produit la fixture Opus du player en passant par l'encodeur reel du device.
add_executable(vassi_make_opus_fixture
  "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/native/make_opus_fixture.cpp"
  "source/audio_encoder.cpp"
)
target_include_directories(vassi_make_opus_fixture PRIVATE "source")
target_link_libraries(vassi_make_opus_fixture PRIVATE Opus::opus vassi_resampler)

# Ce binaire verifie le pont loopback avec un vrai socket d'ecoute local.
add_executable(vassi_frame_sender_test
  "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/native/frame_sender.test.cpp"
  "source/frame_sender.cpp"
)
target_include_directories(vassi_frame_sender_test PRIVATE "source")
target_link_libraries(vassi_frame_sender_test PRIVATE ws2_32)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../.local/max-sdk/source/max-sdk-base/script/max-posttarget.cmake)
