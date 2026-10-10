// swift-tools-version: 5.10
import PackageDescription

// vendor/speech-swift: soniqo/speech-swift @ cbcdfc6 (Apache-2.0), only the four targets voice needs.
// One patch: AudioCommon/HuggingFaceDownloader.swift no longer imports Hub (Shrike downloads the models itself).
let mlx: [Target.Dependency] = [
  .product(name: "MLX", package: "mlx-swift"),
  .product(name: "MLXNN", package: "mlx-swift"),
  .product(name: "MLXFast", package: "mlx-swift"),
]

let package = Package(
  name: "ShrikeVoice",
  platforms: [.macOS("15.0")],
  dependencies: [
    .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.31.6"),
  ],
  targets: [
    .target(name: "AudioCommon", path: "vendor/speech-swift/Sources/AudioCommon"),
    .target(name: "MLXCommon", dependencies: ["AudioCommon", .product(name: "MLXFFT", package: "mlx-swift")] + mlx, path: "vendor/speech-swift/Sources/MLXCommon"),
    .target(name: "NemotronStreamingASR", dependencies: ["AudioCommon", "MLXCommon"] + mlx, path: "vendor/speech-swift/Sources/NemotronStreamingASR"),
    .target(name: "SpeechVAD", dependencies: ["AudioCommon", "MLXCommon"] + mlx, path: "vendor/speech-swift/Sources/SpeechVAD"),
    .executableTarget(name: "ShrikeVoice", dependencies: ["NemotronStreamingASR", "SpeechVAD"], path: ".", sources: ["ShrikeVoice.swift"]),
  ]
)
