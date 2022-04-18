import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ApiService {

  constructor(private http: HttpClient) { }

  getFiles() {
    return firstValueFrom(this.http.get(`/api/files`)) as Promise<{ files: { file: string, existingTags: string[] }[] }>
  }

  getFileInfo(file: string) {
    return firstValueFrom(this.http.get(`/api/file/${file}`)) as Promise<{ file: string, existingTags: string[], description: string }>
  }

  async updateFileInfo(file: string, tags: string[], description: string) {
    await firstValueFrom(this.http.post(`/api/file/${file}`, { tags, description }))
  }

  getTags() {
    return firstValueFrom(this.http.get(`/api/tags`)) as Promise<string[]>
  }
}
