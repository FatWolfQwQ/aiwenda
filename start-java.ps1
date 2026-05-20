$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (!(Test-Path "build")) {
  New-Item -ItemType Directory -Path "build" | Out-Null
}

javac -encoding UTF-8 -cp "lib\*" -d build src\main\java\com\zhishu\Json.java src\main\java\com\zhishu\RagEngine.java src\main\java\com\zhishu\App.java
java -cp "build;lib\*" com.zhishu.App


