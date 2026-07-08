param(
    [string]$InputRoot = "C:\Users\jonam\Downloads\meeting-sog-optimized\sh0-i2",
    [string]$OutputDir = "C:\Users\jonam\Downloads\meeting-official-voxel",
    [string]$OutputName = "meeting-prototype-room-splat-transform-outdoor-floor-fill-v1",
    [string]$SplatTransformVersion = "2.6.0",
    [string]$Gpu = "0",
    [string]$Decimate = "15%",
    [ValidateSet("floor", "external", "none")]
    [string]$FillMode = "floor",
    [string]$FillSize = "1.6",
    [string]$SeedPos = "",
    [string]$VoxelCarve = ""
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$output = Join-Path $OutputDir "$OutputName.voxel.json"
$bounds = "-8.5,-0.5,-11.5,12.5,4.8,25"

$layers = @(
    @{
        Path = Join-Path $InputRoot "sunset-in-the-ice-cave-2d57968d.sog"
        Scale = "1"
        Rotate = "0,0,180"
        Translate = "0,1.2778444290161133,0"
    },
    @{
        Path = Join-Path $InputRoot "pawson-lounge-chair-e4b40508-sh0-i2.sog"
        Scale = "0.08861789568937857"
        Rotate = "-180,13.398154234943247,0"
        Translate = "0.5876619219779968,0,-0.17784488201141357"
    },
    @{
        Path = Join-Path $InputRoot "classic-chair-bd5a73ed-sh0-i2.sog"
        Scale = "0.14696067336987376"
        Rotate = "180,-76.74983962892313,0"
        Translate = "1.3528807163238525,-0.07964105904102325,2.870152711868286"
    },
    @{
        Path = Join-Path $InputRoot "armchair-synthetic-bb614620-sh0-i2.sog"
        Scale = "1.0000000085210414"
        Rotate = "180,-85.19999364251248,0"
        Translate = "-0.7185140252113342,0,3.2121546268463135"
    },
    @{
        Path = Join-Path $InputRoot "the-spanish-dining-armchair-9febe4af-sh0-i2.sog"
        Scale = "0.08861789852380753"
        Rotate = "0,0,180"
        Translate = "0.30050116777420044,-0.032640330493450165,3.151154041290283"
    },
    @{
        Path = Join-Path $InputRoot "2006-ksk7501-shrek-tv-500e652d-sh0-i2.sog"
        Scale = "1.000000007502852"
        Rotate = "0,-18.31084599375696,180"
        Translate = "-1.8303585052490234,0.3110590875148773,-2.0822739601135254"
    },
    @{
        Path = Join-Path $InputRoot "modern-fabric-accent-chair-0535b746.sog"
        Scale = "0.9609321383295404"
        Rotate = "-138.665686947434,-82.80388845934974,-41.24682191637563"
        Translate = "2.8589746952056885,0.037077322602272034,2.620384931564331"
    }
)

$argsList = @("--yes", "@playcanvas/splat-transform@$SplatTransformVersion", "-w", "-g", $Gpu)

foreach ($layer in $layers) {
    $argsList += @(
        $layer.Path,
        "-s", $layer.Scale,
        "-r", $layer.Rotate,
        "-t", $layer.Translate,
        "-B", $bounds
    )

    if ($Decimate) {
        $argsList += @("-F", $Decimate)
    }
}

$argsList += @("--voxel-params", "0.18,0.02")

if ($FillMode -eq "floor") {
    $argsList += @("--voxel-floor-fill", $FillSize)
} elseif ($FillMode -eq "external") {
    $argsList += @("--voxel-external-fill", $FillSize)
}

if ($SeedPos) {
    $argsList += @("--seed-pos", $SeedPos)
}

if ($VoxelCarve) {
    $argsList += @("--voxel-carve", $VoxelCarve)
}

$argsList += @(
    $output,
    "-K", "faces",
    "--verbose",
    "--mem"
)

Write-Host "Running official SplatTransform voxel generation:"
Write-Host "npx $($argsList -join ' ')"
& npx.cmd @argsList
